#!/usr/bin/env bash
# Offline tests for assemble.sh and scan-day.sh: gh, df, zeroed-scan, node and sleep are
# PATH stubs (gh over a fake release store), so no network is used and nothing waits.   bash research/historical/ci/test-ci.sh
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
T=$(mktemp -d)
export RUNNER_TEMP="$T/rt"; mkdir -p "$RUNNER_TEMP" # (assemble.sh and volume-day.sh keep their QA logs there, ruling 53)
trap 'rm -rf "$T"' EXIT
export T GITHUB_REPOSITORY=test/repo GITHUB_SHA=abc123 FAKE_AVAIL=999999999999999
# OF-4: the private store the publish, volume and assemble scripts read and write
export DATA_REPO=test/data
mkdir -p "$T/bin" "$T/rel"
pass=0 fail=0
ok() { echo "ok   $1"; pass=$((pass + 1)); }
no() { echo "FAIL $1"; fail=$((fail + 1)); }

# ---- stubs ----
cat > "$T/bin/gh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
[[ "$1" == release ]] || exit 2
# OF-4: every release call is logged with the repository it names and the token it holds
repo=-; prev=""; for x in "$@"; do [[ "$prev" == --repo ]] && repo=$x; prev=$x; done
echo "$2 $3 repo=$repo token=${GH_TOKEN:--}" >> "$T/ghrepo.log"
cmd=$2 tag=$3; shift 3
dir="$T/rel/$tag"
case "$cmd" in
  view)
    [[ -n "${FAKE_GH_ERROR:-}" ]] && { echo "HTTP 502: Bad Gateway" >&2; exit 1; }
    [[ -d "$dir" ]] || { echo "release not found" >&2; exit 1; }
    jqx=""
    while (( $# )); do [[ "$1" == --jq ]] && jqx=$2; shift; done
    [[ -z "$jqx" ]] && exit 0
    draft=false; [[ -e "$dir/.draft" ]] && draft=true
    (cd "$dir" && for f in *; do [[ -e "$f" ]] || continue
      st=uploaded; grep -qx "$f" .partial 2>/dev/null && st=starter
      printf '{"name":"%s","size":%d,"state":"%s"}\n' "$f" "$(stat -c %s "$f")" "$st"; done) |
      jq -s --argjson d "$draft" '{isDraft: $d, assets: .}' | jq -r "$jqx" ;;
  download)
    [[ -d "$dir" ]] || exit 1
    out="" pats=()
    while (( $# )); do
      case "$1" in --dir) out=$2; shift ;; --pattern) pats+=("$2"); shift ;; esac; shift
    done
    # downloads.log lists data downloads; reading only SHA256SUMS or the readback-ok marker
    # (release-state.sh judging a release) is not one
    for p in "${pats[@]}"; do [[ "$p" == SHA256SUMS-* || "$p" == readback-ok-* ]] || { echo "$tag" >> "$T/downloads.log"; break; }; done
    for p in "${pats[@]}"; do echo "$tag $p" >> "$T/dlpat.log"; done
    for p in "${pats[@]}"; do for f in "$dir"/$p; do [[ -e "$f" ]] && cp "$f" "$out/"; done; done
    # OF-4: FAKE_GH_CORRUPT=NAME hands back a changed copy of that asset (a read-back mismatch)
    [[ -n "${FAKE_GH_CORRUPT:-}" && -e "$out/$FAKE_GH_CORRUPT" ]] && echo changed >> "$out/$FAKE_GH_CORRUPT"
    true ;;
  create)
    mkdir "$dir"; echo "$tag" >> "$T/created.log"
    while (( $# )) && [[ "$1" != -- ]]; do shift; done
    (( $# )) && { shift; (( $# )) && cp -- "$@" "$dir/"; }
    # OF-4 ruling 9: FAKE_GH_DROP=NAME loses that asset on create (an incomplete release)
    [[ -n "${FAKE_GH_DROP:-}" ]] && rm -f "$dir/$FAKE_GH_DROP"
    true ;;
  upload)
    while (( $# )) && [[ "$1" != -- ]]; do shift; done; shift
    cp -- "$@" "$dir/" ;;
  *) exit 2 ;;
esac
EOF
cat > "$T/bin/df" <<'EOF'
#!/usr/bin/env bash
echo Avail; echo "$FAKE_AVAIL"
EOF
cat > "$T/bin/zeroed-scan" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
echo "$*" > "$T/finalize.args"
while (( $# )); do case "$1" in -dataset) ds=$2 ;; -from) from=$2 ;; esac; shift; done
mkdir -p "$ds/days/$from"
echo rows > "$ds/days/$from/curve_trades-0000.csv.zst"
echo '{}' > "$ds/manifest.json"; echo m > "$ds/mints-0000.csv.zst"
EOF
cat > "$T/bin/node" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
[[ "$1" == --no-warnings ]] && shift
mkdir -p "$2/qa"
case "$1" in
  */check.mjs) echo report > "$2/qa/report.md"; echo '{}' > "$2/qa/report.json"; echo "$*" > "$T/check.args" ;;
  */parity.ts) echo '{"ok":true}' > "$2/qa/parity.json" ;;
  *) exit 2 ;;
esac
EOF
chmod +x "$T/bin"/*
REAL_NODE_DIR=$(dirname "$(command -v node)")
export PATH="$T/bin:$PATH"

# make_day DAY UNIT...: a day release whose tar holds units/900/UNIT with all files.
make_day() {
  local day=$1; shift
  local src="$T/src-$day" dir="$T/rel/data-day-$day" u
  mkdir -p "$dir"
  for u in "$@"; do
    mkdir -p "$src/units/900/$u"
    for f in events.jsonl.zst blocks.csv.zst curve_trades.csv.zst raw.jsonl.zst; do
      head -c 3000 /dev/zero | tr '\0' x > "$src/units/900/$u/$f"; echo "$u" >> "$src/units/900/$u/$f"
    done
    # seconds and finished_at differ per day's scan (allowed); STATS_REV_<day> overrides
    # one day's scanner_revision (a midnight unit must then fail).
    local rv="STATS_REV_${day//-/_}"
    printf '{"schema":1,"epoch":900,"from_slot":1,"to_slot":2,"blocks":3,"scanner_revision":"%s","seconds":%d,"finished_at":"%sT01:00:00Z"}\n' \
      "${!rv:-r1}" "$((10#${day: -2}))" "$day" > "$src/units/900/$u/stats.json"
  done
  (cd "$src" && tar -cf - units) | split -b 4000 -d -a 2 - "$dir/units-$day.tar.part"
  (cd "$src" && find units -mindepth 3 -maxdepth 3 \( -name events.jsonl.zst -o -name stats.json -o -name blocks.csv.zst \) | LC_ALL=C sort |
    tar --no-recursion -cf "$dir/events-$day.tar" -T -)
  # the rest of a done release (OF-5 rulings 1 and 4): QA, manifest, parity, per-unit log and the readback-ok marker
  for f in qa-$day.md qa-$day.json manifest-$day.json parity-$day.json units-$day.log; do echo "$f" > "$dir/$f"; done
  (cd "$dir" && sha256sum units-"$day".tar.part* events-"$day".tar qa-* manifest-* parity-* units-"$day".log > "SHA256SUMS-$day")
  printf 'readback-ok data-day-%s %s' "$day" "$(sha256sum "$dir/SHA256SUMS-$day" | cut -d' ' -f1)" > "$dir/readback-ok-$day"
  rm -rf "$src"
}
reset_store() {
  rm -rf "$T/rel" "$T/work" "$T"/*.log "$T"/*.args; mkdir -p "$T/rel"
  local d
  for i in $(seq 0 16); do
    d=$(date -u -d "2026-09-05 + $i days" +%F)
    if [[ "$d" == 2026-09-19 ]]; then make_day "$d" "u$i" cross   # crosses midnight into 09-20
    elif [[ "$d" == 2026-09-20 ]]; then make_day "$d" cross "u$i"
    else make_day "$d" "u$i"; fi
  done
}
# OF-4 ruling 5: download (store token), build (no token), store (store token)
run() { { bash "$here/assemble.sh" --download "$@" && env -u GH_TOKEN -u GITHUB_TOKEN bash "$here/assemble.sh" "$@" && bash "$here/assemble.sh" --store "$@"; } > "$T/out.txt" 2>&1; }

# ---- 1. full offline run: FROM 09-20, TO 09-22, lead-in 09-06 .. 09-19 ----
reset_store
if run 2026-09-20 2026-09-22 "$T/work"; then ok "assemble runs end to end"; else no "assemble runs end to end"; cat "$T/out.txt"; fi
dl=$(grep '^data-day-' "$T/downloads.log" | sort | tr '\n' ' ')
exp=$(for i in $(seq 1 16); do date -u -d "2026-09-05 + $i days" +data-day-%F; done | sort | tr '\n' ' ')
[[ "$dl" == "$exp" ]] && ok "downloads exactly the 14 lead-in and 2 window days" || no "downloads: $dl"
grep -q data-day-2026-09-05 "$T/downloads.log" && no "day before the lead-in was downloaded" || ok "no day before the lead-in is read"
U="$T/work/data/units/900"
[[ -e "$U/u1/events.jsonl.zst" && -e "$U/u1/stats.json" && -e "$U/u1/blocks.csv.zst" && ! -e "$U/u1/curve_trades.csv.zst" ]] &&
  ok "lead-in units hold only events, stats and blocks" || no "lead-in extraction filter"
[[ -e "$U/u15/curve_trades.csv.zst" && -e "$U/u15/raw.jsonl.zst" ]] && ok "window units are complete" || no "window units"
[[ -e "$U/cross/curve_trades.csv.zst" && -e "$U/cross/events.jsonl.zst" ]] &&
  ok "unit crossing midnight: same files kept, window-only files moved in" || no "midnight unit merge"
grep -q '"finished_at":"2026-09-19' "$U/cross/stats.json" &&
  ok "midnight unit: stats.json copies differing in seconds/finished_at merge, first copy kept" || no "midnight stats.json: $(cat "$U/cross/stats.json")"
ls -d "$T/work"/dl-* >/dev/null 2>&1 && no "per-day temp dirs left behind" || ok "per-day parts and temp dirs deleted"
grep -q -- "-lead-in-days 14" "$T/finalize.args" && grep -q -- "-part-mb 1900" "$T/finalize.args" && grep -q -- "-regimes .*regimes.json" "$T/finalize.args" &&
  ! grep -q -- "-allow-revisions" "$T/finalize.args" && ok "finalize gets -part-mb 1900 -lead-in-days 14, no -allow-revisions" || no "finalize args: $(cat "$T/finalize.args")"
grep -q -- "--live 60 --strict" "$T/check.args" && ok "strict QA with --live 60" || no "check args"
R="$T/rel/data-2026-09-20-2026-09-22"
[[ -e "$R/2026-09-20__curve_trades-0000.csv.zst" && -e "$R/manifest.json" && -e "$R/mints-0000.csv.zst" && -e "$R/qa-report.md" && -e "$R/qa-report.json" && -e "$R/parity.json" ]] &&
  (cd "$R" && sha256sum -c --quiet SHA256SUMS) && ok "release data-FROM-TO holds flat day files, manifest, mints, QA, parity, valid SHA256SUMS" || no "release contents: $(ls "$R" 2>&1)"
[[ ! -e "$T/work/dataset/manifest.json" ]] && ok "release files were moved, not copied" || no "dataset files still present"

# ---- 2. refusals ----
run 2026-09-01 2026-09-05 "$T/w2" && no "4-day window accepted" || { grep -q "limit is 3" "$T/out.txt" && ok "window over 3 days refused (default)" || no "window message: $(cat "$T/out.txt")"; }
MAX_WINDOW_DAYS=2 run 2026-09-20 2026-09-23 "$T/w2" && no "MAX_WINDOW_DAYS ignored" || ok "MAX_WINDOW_DAYS is honoured"
run 2026-09-22 2026-09-20 "$T/w2" && no "reversed window accepted" || ok "reversed window refused"
run 2026-09-20 2026-09-22 "$T/w3" && no "existing dataset release replaced" || { grep -q "already exists" "$T/out.txt" && ok "existing dataset release refused" || no "existing release message"; }

reset_store; rm -rf "$T/rel/data-day-2026-09-10"
run 2026-09-20 2026-09-22 "$T/work" && no "missing lead-in day skipped silently" ||
  { grep -q "data-day-2026-09-10 is missing" "$T/out.txt" && [[ ! -s "$T/downloads.log" ]] && ok "missing lead-in day fails before any download" || no "missing day: $(cat "$T/out.txt")"; }
# OF-5 ruling 4: a complete day release without its readback-ok marker is refused before any download
reset_store; rm "$T/rel/data-day-2026-09-21/readback-ok-2026-09-21"
bash "$here/assemble.sh" --download 2026-09-20 2026-09-22 "$T/work" > "$T/out.txt" 2>&1 && no "assemble took an unmarked day" ||
  { grep -q "data-day-2026-09-21 is not done (complete); stopped for review" "$T/out.txt" && [[ ! -s "$T/downloads.log" && ! -d "$T/work" ]] &&
    ok "OF-5 ruling 4: assemble --download refuses a complete day release without its readback-ok marker before any download" || no "OF-5 ruling 4: $(cat "$T/out.txt")"; }
reset_store; echo units-2026-09-12.tar.part00 > "$T/rel/data-day-2026-09-12/.partial"
bash "$here/assemble.sh" --download 2026-09-20 2026-09-22 "$T/work" > "$T/out.txt" 2>&1 && no "assemble took a partial day" ||
  { grep -q "data-day-2026-09-12 is not done (incomplete" "$T/out.txt" && [[ ! -s "$T/downloads.log" ]] && ok "OF-5 ruling 4: assemble --download refuses a day release with an asset not uploaded before any download" || no "OF-5 ruling 4 partial: $(cat "$T/out.txt")"; }

reset_store
FAKE_AVAIL=1000 run 2026-09-20 2026-09-22 "$T/work" && no "disk guard passed" || { grep -q "not enough disk" "$T/out.txt" && [[ ! -s "$T/downloads.log" ]] && ok "free-space guard (all the days' assets + 10 GB before the download; 2x a day's assets + 10 GB before its extraction)" || no "disk guard message"; }

reset_store; echo junk >> "$T/rel/data-day-2026-09-21/units-2026-09-21.tar.part00"
run 2026-09-20 2026-09-22 "$T/work" && no "corrupt part accepted" || { grep -q "checksum mismatch" "$T/out.txt" && ok "corrupt window part fails the checksum" || no "checksum message: $(cat "$T/out.txt")"; }
reset_store; echo junk >> "$T/rel/data-day-2026-09-08/events-2026-09-08.tar"
run 2026-09-20 2026-09-22 "$T/work" && no "corrupt events asset accepted" || { grep -q "events asset checksum mismatch" "$T/out.txt" && ok "corrupt lead-in events asset fails the checksum" || no "events checksum message: $(cat "$T/out.txt")"; }
# (OF-5 ruling 4: a release without its tar parts is not done, so this reads the download patterns)
reset_store; rm -f "$T/dlpat.log"
run 2026-09-20 2026-09-22 "$T/work" || true
grep -qx "data-day-2026-09-10 events-2026-09-10.tar" "$T/dlpat.log" && ! grep -q "^data-day-2026-09-10 units-" "$T/dlpat.log" && grep -q "^data-day-2026-09-21 units-2026-09-21.tar.part" "$T/dlpat.log" &&
  ! ls "$T/work"/dl-* >/dev/null 2>&1 && [[ -f "$T/rel/data-2026-09-20-2026-09-22/manifest.json" ]] &&
  ok "lead-in days download only the events asset (never their tar parts); window days their parts" || no "lead-in events-only: $(tail -3 "$T/out.txt")"

STATS_REV_2026_09_20=r2 reset_store
run 2026-09-20 2026-09-22 "$T/work" && no "midnight unit with another scanner_revision accepted" ||
  { grep -q "differs between days: stats.json differs in scanner_revision" "$T/out.txt" && ok "midnight unit with a different scanner_revision fails" || no "revision message: $(cat "$T/out.txt")"; }
STATS_REV_2026_09_20=r2 reset_store
ALLOW_REVISIONS=r1,r2 run 2026-09-20 2026-09-22 "$T/work" && grep -q "allow-revisions r1,r2" "$T/finalize.args" &&
  ok "midnight unit across two revisions merges when both are in ALLOW_REVISIONS (data files still hash equal)" || no "allowed revisions: $(tail -3 "$T/out.txt")"
STATS_REV_2026_09_20=r2 reset_store
ALLOW_REVISIONS=r1,r3 run 2026-09-20 2026-09-22 "$T/work" && no "midnight unit with an unlisted revision accepted" ||
  { grep -q "stats.json differs in scanner_revision" "$T/out.txt" && ok "midnight unit fails when one of its two revisions is not in ALLOW_REVISIONS" || no "unlisted revision: $(cat "$T/out.txt")"; }

reset_store
ALLOW_REVISIONS="rev1;rm" run 2026-09-20 2026-09-22 "$T/work" && no "bad ALLOW_REVISIONS accepted" || ok "malformed ALLOW_REVISIONS refused"
reset_store
ALLOW_REVISIONS=rev1,rev2 run 2026-09-20 2026-09-22 "$T/work" && grep -q -- "-allow-revisions rev1,rev2" "$T/finalize.args" &&
  ok "ALLOW_REVISIONS passed as -allow-revisions" || no "ALLOW_REVISIONS pass-through"

# ---- OF-2 fixture: an armed copy of the CI scripts, and a gh stub for the guard ----
# mkfx DIR [KEY=VALUE...]: research/historical/ci copied to DIR, with scanner/archive.go
# at 10 requests/s, docs/DECISIONS.md holding one pinned B10-PULL row (id b10pull-test-1)
# and archive-limits.conf armed (ARCHIVE_ARM b10pull-test-1, ARCHIVE_REARM_AT
# 2026-10-01T00:00:00Z, ARCHIVE_RETENTION K2) unless a KEY=VALUE overrides it.
mkfx() {
  local dir=$1 kv k; shift
  rm -rf "$dir"; mkdir -p "$dir/research/historical/ci" "$dir/research/historical/scanner" "$dir/docs"
  cp "$here"/*.sh "$here/archive-limits.conf" "$dir/research/historical/ci/"
  # OF-4 landed: the real scripts store days in the private store and data-scan.yml has no
  # day-DAY artifact and no contents: write, so both are copied as they are.
  mkdir -p "$dir/.github/workflows"
  cp "$here/../../../.github/workflows/data-scan.yml" "$dir/.github/workflows/data-scan.yml"
  sed 's/^var reqLimiter = newLimiter([0-9.]*)$/var reqLimiter = newLimiter(10)/' "$here/../scanner/archive.go" > "$dir/research/historical/scanner/archive.go"
  cp "$here/../scanner/main.go" "$dir/research/historical/scanner/main.go" # OF-6: the unit size (unitSlots)
  printf '| 2026-10-08 | B10-PULL id=b10pull-test-1 source=old-faithful scannerRev=r1 days=2026-07-22..2026-08-21 pinnedAt=2026-10-08T00:00:00Z | t | t |\n' > "$dir/docs/DECISIONS.md"
  for kv in ARCHIVE_ARM=b10pull-test-1 ARCHIVE_REARM_AT=2026-10-01T00:00:00Z ARCHIVE_RETENTION=K2 "$@"; do
    k=${kv%%=*}
    grep -q "^$k=" "$dir/research/historical/ci/archive-limits.conf" || { echo "mkfx: no $k in archive-limits.conf" >&2; return 1; }
    sed -i "s|^$k=.*|$k=\"${kv#*=}\"|" "$dir/research/historical/ci/archive-limits.conf"
  done
}
FX="$T/fx/research/historical/ci"
mkfx "$T/fx" || no "OF-2 fixture"
iso() { date -u -d "@$1" +%FT%TZ; }
# The guard's gh stub (GH_BIN), state in $GD: the store (o/data) private unless
# GD_PUBLIC, unreadable with GD_STORE_FAIL, storage-stop with GD_STOP, day tags from
# $GD/published (each carries its readback-ok marker unless $GD/unmarked lists it; OF-5
# ruling 1); a day release's units-D.log and SHA256SUMS-D from $GD/rel/data-day-TAG when
# present, else made up (K3 with its list, but K2 for the plain 07-22 and 07-23); runs of data-scan.yml ($GD/ds.json) and archive-check.yml ($GD/ac.json,
# default: this run, 900, in progress), jobs from $GD/jobs-ID.json, caches from
# $GD/caches.json (GD_CACHE_FAIL: unreadable); dispatches to $GD/dispatch.log; every call
# to $GD/gh.log.
GD="$T/gd"; mkdir -p "$GD/bin"
cat > "$GD/bin/gh" <<'SH'
#!/usr/bin/env bash
echo "gh $*" >> "$GD/gh.log"
jqx=; path=
for ((i = 1; i <= $#; i++)); do
  a=${!i}
  if [[ "$a" == --jq ]]; then j=$((i + 1)); jqx=${!j}; fi
  if [[ "$a" == repos/* && -z "$path" ]]; then path=$a; fi
done
out() { printf '%s' "$1" | jq -r "$jqx"; }
[[ "$1" == --version ]] && { echo "gh version 2.89.0 (stub)"; exit 0; }
case "$1 $2" in
  "run list")
    # --help: what ruling 43 reads (GD_OLD_GH: a gh without --created)
    if [[ " $* " == *" --help "* ]]; then
      [[ -n "${GD_OLD_GH:-}" ]] || echo "      --created date      Filter runs by the date it was created"
      echo "  -s, --status string     Filter runs by status: {queued|completed|in_progress|requested|waiting|pending|action_required}"; exit 0
    fi
    wf=; cr=; st=; for ((i = 1; i <= $#; i++)); do j=$((i + 1)); case "${!i}" in --workflow) wf=${!j} ;; --created) cr=${!j#>=} ;; --status) st=${!j} ;; esac; done
    [[ -n "${GD_RUNS_FAIL:-}" ]] && exit 1
    if [[ "$wf" == archive-check.yml ]]; then f="$GD/ac.json"; else f="$GD/ds.json"; fi
    if [[ -f "$f" ]]; then all=$(cat "$f"); elif [[ "$wf" == archive-check.yml ]]; then
      all="[{\"databaseId\": 900, \"status\": \"in_progress\", \"conclusion\": null, \"createdAt\": \"$(date -u +%FT%TZ)\", \"updatedAt\": \"$(date -u +%FT%TZ)\", \"attempt\": 1, \"headBranch\": \"main\", \"displayTitle\": \"archive-check\"}]"
    else all='[]'; fi
    # the filters gh applies: created on or after a time, one status
    out "$(jq --arg cr "$cr" --arg st "$st" '[.[] | select(($cr == "" or .createdAt >= $cr) and ($st == "" or .status == $st))]' <<< "$all")" ;;
  "workflow run") echo "$*" >> "$GD/dispatch.log" ;;
  "release view"|"release download")
    [[ -n "${GD_STORE_FAIL:-}" || -z "$GH_TOKEN" ]] && { echo "HTTP 401" >&2; exit 1; }
    t=${3#data-day-}; dir=; pats=()
    for ((i = 4; i <= $#; i++)); do j=$((i + 1)); case "${!i}" in --dir) dir=${!j} ;; --pattern) pats+=("${!j}") ;; esac; done
    grep -qx "$t" "$GD/published" 2>/dev/null || { echo "release not found" >&2; exit 1; }
    src="$GD/rel/data-day-$t"; [[ -d "$src" ]] || "$GD/bin/mkrel" "$t"
    if [[ $2 == view ]]; then
      (cd "$src" && for f in *; do st=uploaded; grep -qx "$f" .partial 2>/dev/null && st=starter; printf '{"name":"%s","state":"%s"}\n' "$f" "$st"; done) |
        jq -s '{isDraft: false, assets: .}' | jq -r "$jqx"
    else
      for p in "${pats[@]}"; do for f in "$src"/$p; do [[ -e "$f" ]] && cp "$f" "$dir/"; done; done
    fi
    true ;;
  api*)
    case "$path" in
      repos/o/r) out '{"default_branch": "main", "private": false}' ;;
      repos/o/r/actions/caches*)
        [[ -n "${GD_CACHE_FAIL:-}" ]] && exit 1
        pre=${path#*key=}; pre=${pre%%&*}
        c='{"actions_caches": []}'; [[ -f "$GD/caches.json" ]] && c=$(cat "$GD/caches.json")
        out "$(printf '%s' "$c" | jq --arg p "$pre" '{actions_caches: [.actions_caches[] | select(.key | startswith($p))]}')" ;;
      repos/o/r/check-runs/*/annotations*)
        [[ -n "${GD_ANN_FAIL:-}" ]] && exit 1
        x=${path#repos/o/r/check-runs/}; id=${x%%/*}
        [[ -f "$GD/ann-$id.json" ]] && out "$(cat "$GD/ann-$id.json")" || out '[]' ;;
      repos/o/r/branches*) out "$(cat "$GD/branches.json")" ;;
      repos/o/r/tags*) if [[ -f "$GD/tags.json" ]]; then out "$(cat "$GD/tags.json")"; else out '[]'; fi ;;
      repos/o/r/contents/*)
        b=${path##*ref=}; fp=${path#repos/o/r/contents/}; fp=${fp%%\?*}
        # refs/heads/NAME reads NAME's files, refs/tags/NAME reads tag-NAME's (ruling 48)
        case "$b" in refs/heads/*) b=${b#refs/heads/} ;; refs/tags/*) b=tag-${b#refs/tags/} ;; esac
        [[ -n "${GD_CONTENT_FAIL:-}" ]] && { echo "HTTP 502" >&2; exit 1; }
        case "$fp" in
          .github/workflows/data-scan.yml) f="$GD/wf-$b.yml" ;;
          .github/workflows/archive-check.yml) f="$GD/acwf-$b.yml" ;;
          research/historical/ci/archive-check.sh) f="$GD/acsh-$b.sh" ;;
          # a commit carries the guard unless $GD/noguard-SHA exists (GD_SHA_FAIL: unreadable)
          research/historical/ci/archive-guard.sh)
            [[ -n "${GD_SHA_FAIL:-}" ]] && { echo "HTTP 502" >&2; exit 1; }
            [[ -e "$GD/noguard-$b" ]] && { echo "gh: Not Found (HTTP 404)" >&2; exit 1; }
            out '{"sha": "x"}'; exit 0 ;;
          *) f=/nonexistent ;;
        esac
        [[ -f "$f" ]] || { echo "gh: Not Found (HTTP 404)" >&2; exit 1; }
        out "{\"content\": \"$(base64 -w0 "$f")\"}" ;;
      # the runs API (round 7, ruling 49): created>=TIME or status=S, one page
      repos/o/r/actions/workflows/*/runs*)
        [[ -n "${GD_RUNS_FAIL:-}" ]] && { echo "HTTP 502" >&2; exit 1; }
        wf=${path#repos/o/r/actions/workflows/}; wf=${wf%%/*}; q=${path#*runs?}
        cr=; ce=; st=; [[ "$q" == created=* ]] && { cr=${q#created=}; cr=${cr%%&*}; cr=${cr#>=}; [[ "$cr" == *..* ]] && { ce=${cr#*..}; cr=${cr%%..*}; }; }
        [[ "$q" == status=* ]] && { st=${q#status=}; st=${st%%&*}; }
        if [[ "$wf" == archive-check.yml ]]; then f="$GD/ac.json"; else f="$GD/ds.json"; fi
        if [[ -f "$f" ]]; then all=$(cat "$f"); elif [[ "$wf" == archive-check.yml ]]; then
          all="[{\"databaseId\": 900, \"status\": \"in_progress\", \"conclusion\": null, \"createdAt\": \"$(date -u +%FT%TZ)\", \"updatedAt\": \"$(date -u +%FT%TZ)\", \"attempt\": 1, \"headBranch\": \"main\", \"displayTitle\": \"archive-check\"}]"
        else all='[]'; fi
        # like GitHub: total_count is the whole match, but a search returns at most 1,000 rows (ruling 55)
        out "$(jq --arg cr "$cr" --arg ce "$ce" --arg st "$st" '[.[] | select(($cr == "" or .createdAt >= $cr) and ($ce == "" or .createdAt <= $ce) and ($st == "" or .status == $st))
          | {id: .databaseId, status, conclusion, created_at: .createdAt, updated_at: .updatedAt, run_attempt: .attempt, head_branch: .headBranch, head_sha: .headSha, display_title: .displayTitle}]
          | {total_count: length, workflow_runs: .[:1000]}' <<< "$all")" ;;
      repos/o/r/actions/runs/*/artifacts) out '{"artifacts": [{"name": "resume-2026-07-22"}]}' ;;
      repos/o/r/actions/runs/*/attempts/*/jobs*)
        x=${path#repos/o/r/actions/runs/}; id=${x%%/*}; k=${x#*/attempts/}; k=${k%%/*}
        if [[ -f "$GD/jobs-$id-$k.json" ]]; then out "$(cat "$GD/jobs-$id-$k.json")"
        elif [[ $k == 1 && -f "$GD/jobs-$id.json" ]]; then out "$(cat "$GD/jobs-$id.json")"
        else out '{"jobs": []}'; fi ;;
      repos/o/r/actions/runs/*/attempts/*)
        x=${path#repos/o/r/actions/runs/}; id=${x%%/*}; k=${x##*/}
        if [[ -f "$GD/attempt-$id-$k.json" ]]; then out "$(cat "$GD/attempt-$id-$k.json")"
        else out "$(cat "$GD/ds.json" "$GD/ac.json" 2>/dev/null | jq -s --argjson id "$id" '[.[][] | select(.databaseId == $id)][0] | {status, conclusion, updated_at: .updatedAt}')"; fi ;;
      repos/o/data*)
        [[ -n "${GD_STORE_FAIL:-}" || -z "$GH_TOKEN" ]] && { echo "HTTP 401" >&2; exit 1; }
        case "$path" in
          repos/o/data) if [[ -n "${GD_PUBLIC:-}" ]]; then out '{"private": false}'; else out '{"private": true}'; fi ;;
          repos/o/data/git/matching-refs/tags/storage-stop) [[ -n "${GD_STOP:-}" ]] && out '[{"ref": "refs/tags/storage-stop"}]' || out '[]' ;;
          repos/o/data/git/matching-refs/tags/data-day-)
            out "$( (cat "$GD/published" 2>/dev/null || true) | jq -R '{ref: ("refs/tags/data-day-" + .)}' | jq -s . )" ;;
          *) exit 1 ;;
        esac ;;
      *) exit 1 ;;
    esac ;;
  *) exit 1 ;;
esac
SH
chmod +x "$GD/bin/gh"
# mkrel TAG [R1 R2 SHA]: a complete day release data-day-TAG in $GD/rel (two units at
# retention R1 and R2 with the list's sha256, or SHA; default K3, but K2 for the plain
# 07-22 and 07-23), with its readback-ok marker unless $GD/unmarked lists TAG.
cat > "$GD/bin/mkrel" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
t=$1 d=${1:0:10} dir="$GD/rel/data-day-$1"; r=K3; [[ "$t" == 2026-07-2[23] ]] && r=K2
rm -rf "$dir"; mkdir -p "$dir"; cd "$dir"
echo "list $t" > "list-$d.txt"; s=$(sha256sum "list-$d.txt" | cut -d' ' -f1)
printf '1046/1-4500 r1 %s %s\n1046/4501-9000 r1 %s %s\nk2 %s 1046/1-4500/events.jsonl.zst\n' "${2:-$r}" "${4:-$s}" "${3:-$r}" "${4:-$s}" "$s" > "units-$d.log"
for f in "units-$d.tar.part00" "events-$d.tar" "qa-$d.md" "qa-$d.json" "manifest-$d.json" "parity-$d.json"; do echo "$f" > "$f"; done
sha256sum -- * > "SHA256SUMS-$d"
grep -qx "$t" "$GD/unmarked" 2>/dev/null || printf 'readback-ok data-day-%s %s' "$t" "$(sha256sum "SHA256SUMS-$d" | cut -d' ' -f1)" > "readback-ok-$d"
SH
chmod +x "$GD/bin/mkrel"
# guard ARGS...: archive-guard.sh of the fixture (FXG overrides the copy) with the stub.
guard() { rm -f "$GD/gh.log"; : > "$T/summary.md"
  GD="$GD" GH_BIN="$GD/bin/gh" GH_REPO=o/r DATA_REPO=o/data DATA_STORE_TOKEN=tok GH_TOKEN=ghtok GITHUB_STEP_SUMMARY="$T/summary.md" \
    GITHUB_REF=refs/heads/main GITHUB_RUN_ID=700 GITHUB_RUN_ATTEMPT=1 bash "${FXG:-$FX}/archive-guard.sh" "$@" > "$T/gout.txt" 2>&1; }
# dsrun ID TITLE CONCLUSION CREATED_AGO_MIN UPDATED_AGO_MIN [JOBS]: a completed data-scan
# run for $GD/ds.json (one JSON object a line; dsjson joins them); JOBS "name=conclusion,..."
# goes to $GD/jobs-ID.json.
dsrun() {
  local now; now=$(date -u +%s)
  printf '{"databaseId": %s, "status": "completed", "conclusion": "%s", "createdAt": "%s", "updatedAt": "%s", "attempt": %s, "headBranch": "%s", "headSha": "%s", "displayTitle": "%s"}\n' \
    "$1" "$3" "$(iso $(( now - $4 * 60 )))" "$(iso $(( now - $5 * 60 )))" "${ATTEMPT:-1}" "${BRANCH:-main}" "${SHA:-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa}" "$2"
  [[ -n "${6:-}" ]] && jobsfile "$1" "$6"
  return 0
}
jobsfile() { python3 -c 'import json,sys; print(json.dumps({"jobs": [{"id": int(sys.argv[1]) * 10 + i, "name": n, "conclusion": (None if c == "null" else c), "steps": [{"name": n, "conclusion": (None if c == "null" else c)}]} for i, (n, c) in enumerate(x.rsplit("=", 1) for x in sys.argv[2].split(","))]}))' "$1" "$2" > "$GD/jobs-$1.json"; }
dsjson() { jq -s . > "$GD/ds.json"; }
# acrun ID CONCLUSION AGO_MIN [served]: a completed archive-check run; "notserved" gives it
# a failed "Not served (counted failure)" step.
acrun() {
  local now; now=$(date -u +%s)
  printf '{"databaseId": %s, "status": "completed", "conclusion": "%s", "createdAt": "%s", "updatedAt": "%s", "attempt": %s, "headBranch": "%s", "headSha": "%s", "displayTitle": "archive-check"}\n' \
    "$1" "$2" "$(iso $(( now - $3 * 60 - 1 )))" "$(iso $(( now - $3 * 60 )))" "${ATTEMPT:-1}" "${BRANCH:-main}" "${SHA:-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa}"
  [[ "${4:-}" == notserved ]] && jobsfile "$1" "Archive probe (a failure unless served)=${PROBE:-failure}"
  # the "Record the back-off annotation" step's record (3 h after the probe) unless NOANN
  [[ "${4:-}" == notserved && -z "${NOANN:-}" ]] && printf '[{"title": "archive-backoff", "message": "end=%s"}]\n' $(( now - $3 * 60 + 10800 )) > "$GD/ann-${1}0.json"
  return 0
}
acjson() { { cat; printf '{"databaseId": 900, "status": "in_progress", "conclusion": null, "createdAt": "%s", "updatedAt": "%s", "attempt": 1, "headBranch": "main", "displayTitle": "archive-check"}\n' "$(iso "$(date -u +%s)")" "$(iso "$(date -u +%s)")"; } | jq -s . > "$GD/ac.json"; }
gdreset() { rm -f "$GD"/*.json "$GD"/*.log "$GD/published" "$GD/unmarked"; rm -rf "$GD/rel"; }
# pass DAY RET: a fresh pass of the scan job's guard step for scan-day.sh / check-day.sh.
GP="$T/guardpass"
gpass() { rm -rf "$GP"; mkdir -p "$GP"; echo "$1 $2 $(date -u +%s) 700 1 ${GFAILED:-0}" > "$GP/$1"; }
export GITHUB_RUN_ID=700 GITHUB_RUN_ATTEMPT=1

# ---- 3. scan-day.sh: shared back-off (zeroed-scan and sleep stubs record each call) ----
S="$T/sbin"; mkdir -p "$S"
cat > "$S/zeroed-scan" <<'STUB'
#!/usr/bin/env bash
# unitlog (OF-3 ruling 9's read-done check): exit 2 with UNITLOG_FAIL, else 0; not a scan
if [[ "$1" == unitlog ]]; then echo "$*" >> "$T/unitlog.args"; [[ -n "${UNITLOG_FAIL:-}" ]] && exit 2; exit 0; fi
# first call exits FIRST_RC (75: a 429 with a 10 s back-off in the state), later calls 0
echo scan >> "$T/calls.log"; echo "$*" > "$T/scan.args"
while (( $# )); do [[ "$1" == -out ]] && out=$2; shift; done
# SLOW: a scan that outlasts the budget; interrupted (SIGINT) it exits 1 like the scanner
echo "plan: 12 units curve=5 amm=3" # (ruling 36: archive-derived counts, never in the public log)
[[ -n "${SCAN_FAIL_RC:-}" ]] && exit "$SCAN_FAIL_RC" # a scanner failure (OF-3 ruling 24)
if [[ -n "${SLOW:-}" ]]; then trap 'echo interrupted >> "$T/calls.log"; exit 1' INT; /bin/sleep 30 & wait; exit 0; fi
if [[ $(grep -c scan "$T/calls.log") == 1 && "${FIRST_RC:-0}" == 75 ]]; then
  now=$(date +%s); echo "$now 10 $((now + 10))" > "$out/archive-429.state"
  echo "429 from archive" > "$out/429.log"; exit 75
fi
exit 0
STUB
cat > "$S/sleep" <<'STUB'
#!/usr/bin/env bash
echo "sleep $1" >> "$T/calls.log"
STUB
chmod +x "$S"/*
# A scanner capped at 10 requests/s (archive-limits.conf); variants for the refusals.
for n in 10 40 10.5; do sed "s/^var reqLimiter = newLimiter([0-9.]*)\$/var reqLimiter = newLimiter($n)/" "$here/../scanner/archive.go" > "$T/archive$n.go"; done
grep -v '^var reqLimiter' "$here/../scanner/archive.go" > "$T/archivenone.go"
grep -qx 'var reqLimiter = newLimiter(10)' "$T/archive10.go" || no "test copy of archive.go at 10/s"
# scan OUT [BUDGET]: the armed fixture's scan-day.sh for 2026-07-22 (SDAY overrides) with a
# fresh guard pass (unless NOPASS), as the scan job runs it.
# mkprior DAY: the day before's pinned list list-<D-1>.txt and a SHA256SUMS that lists it
# (OF-3 rulings 8 and 11), in $T/prior.
mkprior() { local p; p=$(date -u -d "$1 - 1 day" +%F); rm -rf "$T/prior"; mkdir -p "$T/prior"
  echo "8rjKP44zZewzNGx6DyF3Ck1Ub6y45pXbures2Dx3pump 100 18100" > "$T/prior/list-$p.txt"
  (cd "$T/prior" && sha256sum "list-$p.txt" > "SHA256SUMS-$p"); PRIORL="$T/prior/list-$p.txt" PRIORS="$T/prior/SHA256SUMS-$p"; }
scan() {
  : > "$T/calls.log"
  local d=${SDAY:-2026-07-22}
  [[ -n "${NOPASS:-}" ]] || gpass "$d" "${PASSRET:-K2}"
  [[ -n "${NOPRIOR:-}" ]] || mkprior "$d"
  # OF-6 ruling 9: a day after the first gets the day before's stored units (none here overlap)
  if [[ -z "${NOPREV:-}" && "$d" != 2026-07-22 && -d "$1" ]]; then [[ -s "$1/prev-units.txt" ]] || echo "1046/999000001-999004500" > "$1/prev-units.txt"; touch "$1/from-store.txt"; fi
  ARCHIVE_PRIOR_LIST=${SPL-$PRIORL} ARCHIVE_PRIOR_SUMS=${SPS-$PRIORS} \
  ARCHIVE_GO=${ARCHIVE_GO:-$T/archive10.go} ARCHIVE_GUARD_DIR="$GP" SCANNER_REVISION=${SREV-r1} ARCHIVE_MIGRATION_LIST="${SLIST:-}" PATH="$S:$PATH" GITHUB_STEP_SUMMARY="$T/summary.md" bash "${SFX:-$FX}/scan-day.sh" "$d" "$1" "${MBPS:-40}" "${2:-300}" > "$T/out.txt" 2>&1
}
calls() { tr '\n' ' ' < "$T/calls.log"; }
o="$T/scan1"; mkdir -p "$o"; now=$(date +%s); echo "$((now - 5)) 600 $((now + 120))" > "$o/archive-429.state"
if scan "$o"; then
  mapfile -t c < "$T/calls.log"; c+=(""); w=${c[0]#sleep }; unset "c[-1]"
  [[ ${#c[@]} == 2 && "${c[0]}" == sleep* && "${c[1]}" == scan ]] && (( w >= 110 && w <= 120 )) &&
    ok "scan-day honours an existing back-off: waits until its end (${w} s) before the first scan" || no "existing back-off: $(calls)"
else no "scan-day with an existing back-off: $(cat "$T/out.txt")"; fi
o="$T/scan2"; mkdir -p "$o"; : > "$T/summary.md"
rc=0; t0=$(date +%s); FIRST_RC=75 scan "$o" || rc=$?
end=$(awk '{print $3}' "$o/archive-429.state" 2>/dev/null || true)
[[ $rc == 4 && $(calls) == "scan " ]] && (( end >= t0 + 10800 && end <= t0 + 10810 )) && grep -q "the chain stops, and only a later served archive-check resumes" "$T/summary.md" &&
  ok "ARCHIVE-SAFE: after a 429 the back-off is held to at least 3 h ($(( end - t0 )) s), no resume in the run, exit 4 (not resumable: no chained run)" || no "429 stop: rc=$rc $(calls) $(cat "$o/archive-429.state")"
grep -q "429 from archive" "$T/summary.md" && ls "$o"/429-*.log >/dev/null 2>&1 &&
  ok "429 log goes to the summary and is kept" || no "429 log"
[[ " $(cat "$T/scan.args") " == *" -parallel 1 -dl 4 "* && " $(cat "$T/scan.args") " == *" -max-mbps 40 "* ]] &&
  ok "ARCHIVE-SAFE: the scanner runs with -parallel 1 -dl 4 (4 connections) at 40 MB/s, from archive-limits.conf" || no "scan args: $(cat "$T/scan.args")"
o="$T/scan2b"; mkdir -p "$o"; now=$(date +%s); echo "$now 20000 $((now + 20000))" > "$o/archive-429.state"
bash "$here/scan-day.sh" --hold "$o/archive-429.state" 10800 && [[ $(awk '{print $3}' "$o/archive-429.state") == $((now + 20000)) ]] &&
  bash "$here/scan-day.sh" --hold "$T/scan2b/new/s" 10800 && (( $(awk '{print $3}' "$T/scan2b/new/s") >= now + 10800 )) &&
  ok "ARCHIVE-SAFE: --hold keeps a later back-off end and creates a missing one at least 3 h out" || no "hold"
o="$T/scan2c"; mkdir -p "$o"; rc=0; MBPS=41 scan "$o" || rc=$?
rc2=0; MBPS=0 scan "$o" || rc2=$?
[[ $rc == 2 && $rc2 == 2 && ! -s "$T/calls.log" ]] && grep -q "not in (0, 40\]" "$T/out.txt" && ok "ARCHIVE-SAFE: scan-day refuses max_mbps above 40 (or 0) before any request" || no "mbps cap: $rc $rc2 $(calls)"
bad=""
for g in archive40 archive10.5 archivenone; do
  o="$T/scanrps"; rm -rf "$o"; mkdir -p "$o"; rc=0; ARCHIVE_GO="$T/$g.go" scan "$o" || rc=$?
  [[ $rc == 2 && ! -s "$T/calls.log" ]] && grep -q "request cap" "$T/out.txt" || bad+=" $g:$rc"
done
o="$T/scanrps"; rm -rf "$o"; mkdir -p "$o"; ARCHIVE_GO="$T/archive10.go" scan "$o" && [[ $(calls) == "scan " ]] || bad+=" archive10"
[[ -z "$bad" ]] && ok "ARCHIVE-SAFE: scan-day refuses (exit 2, no request) a scanner request cap of 40, 10.5 or none found, and scans at 10" || no "scan-day rps:$bad"
o="$T/scannd"; rm -rf "$o"; mkdir -p "$o"; : > "$T/calls.log"; rc=0
ARCHIVE_GO="$T/archive10.go" PATH="$S:$PATH" GITHUB_STEP_SUMMARY="$T/summary.md" bash "$here/scan-day.sh" 2026-09-21 "$o" 40 300 > "$T/out.txt" 2>&1 || rc=$?
[[ $rc == 2 && ! -s "$T/calls.log" ]] && grep -q "2026-09-21 is a Helius day" "$T/out.txt" &&
  ok "ARCHIVE-NODUP: scan-day refuses the Helius day 2026-09-21 (exit 2) before any scanner call" || no "scan-day helius day: rc=$rc $(calls)"
o="$T/scan3"; mkdir -p "$o"; now=$(date +%s); echo "$now 7200 $((now + 7200))" > "$o/archive-429.state"
rc=0; scan "$o" 60 || rc=$?
mapfile -t c < "$T/calls.log"; c+=(""); w=${c[0]#sleep }; unset "c[-1]"
[[ $rc == 75 && ${#c[@]} == 1 && "${c[0]}" == sleep* ]] && (( w >= 3290 && w <= 3300 )) &&
  ok "a back-off that does not fit the budget sleeps what the budget allows (${w} s of 3600 left), then exits 75 without scanning" || no "budget exit: rc=$rc $(calls)"
o="$T/scan4"; mkdir -p "$o"; : > "$T/summary.md"
t0=$(date +%s); rc=0; SLOW=1 scan "$o" 2s || rc=$?; t1=$(date +%s)
[[ $rc == 75 && $(calls) == "scan interrupted " ]] && (( t1 - t0 < 15 )) && grep -q "time budget reached while scanning" "$T/summary.md" &&
  ok "the scan is interrupted at the budget's end and exits 75 (resumable) in $((t1 - t0)) s" || no "scan budget: rc=$rc $(calls) $(cat "$T/out.txt")"
o="$T/scan5"; mkdir -p "$o"; rc=0; scan "$o" 0s || rc=$?
[[ $rc == 75 && ! -s "$T/calls.log" ]] && ok "a spent budget exits 75 before scanning" || no "spent budget: rc=$rc $(calls)"
ms="$T/ms"; mkdir -p "$ms"
echo "1 10 2000" > "$ms/late"; echo "1 10 1000" > "$ms/early"; cp "$ms/early" "$ms/dst"
bash "$here/scan-day.sh" --merge-state "$ms/late" "$ms/dst"
[[ $(cat "$ms/dst") == "1 10 2000" ]] && ok "merge-state: a later back-off end replaces an earlier one" || no "merge-state later"
bash "$here/scan-day.sh" --merge-state "$ms/early" "$ms/dst"
[[ $(cat "$ms/dst") == "1 10 2000" ]] && ok "merge-state: an earlier end never replaces a later one" || no "merge-state earlier"
bash "$here/scan-day.sh" --merge-state "$ms/missing" "$ms/dst" && [[ $(cat "$ms/dst") == "1 10 2000" ]] &&
  bash "$here/scan-day.sh" --merge-state "$ms/late" "$ms/new/dir/state" && [[ $(cat "$ms/new/dir/state") == "1 10 2000" ]] &&
  ok "merge-state: a missing source is a no-op, a missing destination is created" || no "merge-state missing"

# ---- 4. pure functions ----
# shellcheck source=assemble.sh
source "$here/assemble.sh"
set +e
m="$T/merge"; mkdir -p "$m/a" "$m/b"
echo same > "$m/a/x"; echo same > "$m/b/x"; echo new > "$m/a/y"
( merge_unit "$m/a" "$m/b" ) && [[ -e "$m/b/y" && ! -e "$m/a" ]] && ok "merge_unit: equal files pass, new files moved, source removed" || no "merge_unit equal"
mkdir -p "$m/c"; echo other > "$m/c/x"
out=$( ( merge_unit "$m/c" "$m/b" ) 2>&1 ) && no "merge_unit accepted a mismatch" || { [[ "$out" == *"differs between days in x"* ]] && ok "merge_unit fails on a hash mismatch" || no "mismatch message: $out"; }
( merge_unit "$m/c" "$m/new/900/r" ) && [[ -e "$m/new/900/r/x" ]] && ok "merge_unit moves a new unit in" || no "merge_unit new"
st='{"schema":1,"epoch":900,"from_slot":1,"to_slot":2,"blocks":3,"scanner_revision":"r1"'
mkdir -p "$m/s1" "$m/s2" "$m/s3"
echo "$st,\"seconds\":1}" > "$m/s1/stats.json"; echo "$st,\"seconds\":2}" > "$m/s2/stats.json"
( merge_unit "$m/s2" "$m/s1" ) && grep -q '"seconds":1' "$m/s1/stats.json" && [[ ! -e "$m/s2" ]] &&
  ok "merge_unit: stats.json differing only in seconds keeps the first copy" || no "merge_unit stats allowed"
echo "${st/\"blocks\":3/\"blocks\":4},\"seconds\":2}" > "$m/s3/stats.json"
out=$( ( merge_unit "$m/s3" "$m/s1" ) 2>&1 ) && no "merge_unit accepted a blocks mismatch" ||
  { [[ "$out" == *"stats.json differs in blocks"* ]] && ok "merge_unit fails on a stats.json identity mismatch (blocks)" || no "stats mismatch message: $out"; }
fg="$T/fg"; mkdir -p "$fg/data/units"; head -c 1000000 /dev/zero > "$fg/data/units/f"
u=$(du -sb "$fg/data/units" | cut -f1)
FAKE_AVAIL=$(( 2 * u + 10000000000 )) bash -c 'source "$1"; finalize_guard "$2"' _ "$here/assemble.sh" "$fg" &&
  ok "finalize_guard passes at exactly 2 x units + 10 GB" || no "finalize_guard pass"
out=$(FAKE_AVAIL=$(( 2 * u + 10000000000 - 1 )) bash -c 'source "$1"; finalize_guard "$2"' _ "$here/assemble.sh" "$fg" 2>&1) && no "finalize_guard passed one byte short" ||
  { [[ "$out" == *"for finalize"* ]] && ok "finalize_guard fails one byte under 2 x units + 10 GB" || no "finalize_guard message: $out"; }
[[ $(day_list 2026-09-20 2026-09-22 | wc -l) == 16 && $(day_list 2026-09-20 2026-09-22 | head -1) == 2026-09-06 ]] && ok "day_list: 14 lead-in days + window" || no "day_list"
ds="$T/big"; mkdir -p "$ds/days/2026-09-20" "$ds/qa"
for i in $(seq 1 995); do : > "$ds/days/2026-09-20/f$i"; done
echo '{}' > "$ds/manifest.json"; : > "$ds/qa/report.md"; : > "$ds/qa/report.json"; : > "$ds/qa/parity.json"
out=$( ( build_release "$ds" "$T/bigrel" ) 2>&1 ) && no "990-asset guard passed" || { [[ "$out" == *"990"* ]] && ok "more than 990 assets refused" || no "asset guard: $out"; }

# ---- scan-day.sh: OF-3 (P2) a cached unit of another scanner revision is refused, never read again ----
bad=""
for st in '{"scanner_revision": "rOld"}' '{"blocks": 3}'; do
  o="$T/scanrev"; rm -rf "$o"; mkdir -p "$o/units/1047/1-2" "$o/units/1047/3-4"
  printf '{\n  "scanner_revision": "rNew"\n}\n' > "$o/units/1047/3-4/stats.json"; echo "$st" > "$o/units/1047/1-2/stats.json"
  rc=0; SREV=rNew scan "$o" || rc=$?
  [[ $rc == 2 && ! -s "$T/calls.log" && -d "$o/units/1047/1-2" && -d "$o/units/1047/3-4" ]] && grep -q "a unit of another revision is never read again" "$T/out.txt" || bad+=" [$st]:$rc"
done
o="$T/scanrev"; rm -rf "$o"; mkdir -p "$o"; rc=0; SREV= scan "$o" || rc=$?
[[ $rc == 2 && ! -s "$T/calls.log" ]] && grep -q "SCANNER_REVISION is not set" "$T/out.txt" || bad+=" [no-rev]:$rc"
o="$T/scanrev"; rm -rf "$o"; mkdir -p "$o/units/1047/3-4"; printf '{\n  "scanner_revision": "rNew",\n  "retention": "K2"\n}\n' > "$o/units/1047/3-4/stats.json"
SREV=rNew scan "$o" && [[ $(calls) == "scan " ]] || bad+=" [same-rev]"
[[ -z "$bad" ]] && ok "OF-3: scan-day refuses (exit 2, no scanner call, nothing deleted) a cached unit of another revision or with none, and a run without SCANNER_REVISION; units of the frozen revision resume" || no "OF-3 revision refusal:$bad"

# ---- publish-day.sh: one day, one create call, existing releases checked, never edited ----
export GH_BIN="$T/bin/gh"
pd="$T/pd"; mkdir -p "$pd"; rm -rf "$T/rel/data-day-2026-09-30"; : > "$T/created.log"
mkpd() {
  rm -f "$pd"/*
  for f in units-2026-09-30.tar.part00 units-2026-09-30.tar.part01 events-2026-09-30.tar qa-2026-09-30.md qa-2026-09-30.json manifest-2026-09-30.json parity-2026-09-30.json units-2026-09-30.log; do echo "$f" > "$pd/$f"; done
  (cd "$pd" && sha256sum units-* events-* qa-* manifest-* parity-* > SHA256SUMS-2026-09-30)
}
mkpd
bash "$here/publish-day.sh" 2026-09-30 "$pd" >/dev/null && [[ $(ls "$T/rel/data-day-2026-09-30" | wc -l) == 10 ]] && [[ -f "$T/rel/data-day-2026-09-30/readback-ok-2026-09-30" ]] &&
  ok "publish-day: release data-day-DAY created with parts, QA, manifest, parity, per-unit log, sums and the readback-ok marker" || no "publish-day create"
echo "rerun QA report with different live results" > "$pd/qa-2026-09-30.md"; echo '{"rerun":1}' > "$pd/qa-2026-09-30.json"
(cd "$pd" && sha256sum units-* events-* qa-* manifest-* parity-* > SHA256SUMS-2026-09-30)
bash "$here/publish-day.sh" 2026-09-30 "$pd" >/dev/null && [[ $(grep -c data-day-2026-09-30 "$T/created.log") == 1 ]] &&
  ! grep -q rerun "$T/rel/data-day-2026-09-30/qa-2026-09-30.md" &&
  ok "publish-day: a complete release is accepted unchanged although the rerun's QA files differ in size" || no "publish-day complete rerun"
o2=$(GITHUB_OUTPUT="$T/ghout" bash "$here/publish-day.sh" --check 2026-09-30) && grep -qx complete=true "$T/ghout" &&
  ok "publish-day --check: a published, complete day is reported (the scan job then skips it before any read)" || no "publish-day check complete: $o2"
: > "$T/ghout"; GITHUB_OUTPUT="$T/ghout" bash "$here/publish-day.sh" --check 2026-09-29 >/dev/null && grep -qx complete=false "$T/ghout" &&
  ok "publish-day --check: an unpublished day is scanned" || no "publish-day check absent"
touch "$T/rel/data-day-2026-09-30/.draft"
out=$(bash "$here/publish-day.sh" 2026-09-30 "$pd" 2>&1) && no "publish-day accepted a draft" ||
  { [[ "$out" == *"draft"* && $(grep -c data-day-2026-09-30 "$T/created.log") == 1 ]] && ok "publish-day: a draft release is refused and not touched" || no "publish-day draft: $out"; }
rm "$T/rel/data-day-2026-09-30/.draft"; echo units-2026-09-30.tar.part00 > "$T/rel/data-day-2026-09-30/.partial"
bash "$here/publish-day.sh" 2026-09-30 "$pd" >/dev/null 2>&1 && no "publish-day accepted a half-uploaded asset" || ok "publish-day: an asset not fully uploaded is refused"
rm "$T/rel/data-day-2026-09-30/.partial"
rm "$T/rel/data-day-2026-09-30/units-2026-09-30.tar.part01"; before=$(ls "$T/rel/data-day-2026-09-30" | sort | tr '\n' ' ')
out=$(bash "$here/publish-day.sh" 2026-09-30 "$pd" 2>&1) && no "publish-day accepted an incomplete release" ||
  { [[ "$out" == *"differ"* && $(ls "$T/rel/data-day-2026-09-30" | sort | tr '\n' ' ') == "$before" && $(grep -c data-day-2026-09-30 "$T/created.log") == 1 ]] &&
    ok "publish-day: a release missing a part (count from its own SHA256SUMS) fails and is not touched" || no "publish-day incomplete: $out"; }
GITHUB_OUTPUT="$T/ghout" bash "$here/publish-day.sh" --check 2026-09-30 >/dev/null 2>&1 && no "--check passed an incomplete release" || ok "publish-day --check: an incomplete release fails the job"
: > "$T/ghout"; FAKE_GH_ERROR=1 GITHUB_OUTPUT="$T/ghout" bash "$here/publish-day.sh" --check 2026-09-28 >/dev/null 2>&1 && no "--check treated a gh error as absent" ||
  { [[ ! -s "$T/ghout" ]] && ok "publish-day --check: a gh error other than 'release not found' fails, never reads as absent" || no "check gh error"; }
rm -rf "$T/rel/data-day-2026-09-30"; mkpd; echo corrupt >> "$pd/units-2026-09-30.tar.part00"
bash "$here/publish-day.sh" 2026-09-30 "$pd" >/dev/null 2>&1 && no "publish-day published a corrupt part" ||
  { [[ ! -d "$T/rel/data-day-2026-09-30" ]] && ok "publish-day: a checksum mismatch publishes nothing" || no "publish-day corrupt"; }
mkpd; rm "$pd/parity-2026-09-30.json"; (cd "$pd" && sha256sum units-* events-* qa-* manifest-* > SHA256SUMS-2026-09-30)
bash "$here/publish-day.sh" 2026-09-30 "$pd" >/dev/null 2>&1 && no "publish-day published without parity" || ok "publish-day: a missing parity report publishes nothing"
mkpd; (cd "$pd" && sha256sum units-* events-* qa-* manifest-* > SHA256SUMS-2026-09-30)
out=$(bash "$here/publish-day.sh" 2026-09-30 "$pd" 2>&1) && no "publish-day published a file missing from SHA256SUMS" ||
  { [[ "$out" == *"not listed"* && ! -d "$T/rel/data-day-2026-09-30" ]] && ok "publish-day: a file not listed in SHA256SUMS publishes nothing" || no "publish-day unlisted: $out"; }
printf '#!/usr/bin/env bash\necho "$*" >> "%s/ghcalls.log"\n' "$T" > "$T/ghrec"; chmod +x "$T/ghrec"; : > "$T/ghcalls.log"
out=$(GH_BIN="$T/ghrec" bash "$here/publish-day.sh" 2026-10-02 "$pd" 2>&1) && no "publish-day published the regime-boundary day" ||
  { [[ "$out" == *"regime boundary"* && ! -s "$T/ghcalls.log" ]] && ok "publish-day: 2026-10-02 and later refused before any gh call" || no "publish-day boundary: $out"; }
unset GH_BIN

# ---- volume-asset.sh and publish-volume.sh: release data-volume-DAY, never edited ----
export GH_BIN="$T/bin/gh"
vd="$T/vol"; rm -rf "$vd"; mkdir -p "$vd/ds/days/2026-09-30" "$vd/ds/qa" "$vd/assets"
s0=$(date -u -d 2026-09-30 +%s)
vrows() { echo "hour_start_ms,lamports,covered"; for i in $(seq 0 23); do echo "$(( (s0 + i * 3600) * 1000 )),$(( i == 5 ? ${1:-1123} : 0 )),1"; done; }
vrows | "$REAL_NODE_DIR/node" -e 'const z=require("zlib");process.stdout.write(z.zstdCompressSync(require("fs").readFileSync(0)))' > "$vd/ds/days/2026-09-30/volume_hours-000.csv.zst"
echo '{"mismatches": [], "problems": []}' > "$vd/ds/qa/volume.json"
PATH="$REAL_NODE_DIR:$PATH" bash "$here/volume-asset.sh" "$vd/ds" 2026-09-30 "$vd/assets" >/dev/null && cmp -s <(vrows) "$vd/assets/volume-hours-2026-09-30.csv" &&
  [[ -f "$vd/assets/volume-check-2026-09-30.json" ]] && ok "volume-asset: plain 24-hour CSV and the cross-check result" || no "volume-asset"
rm -rf "$T/rel/data-volume-2026-09-30"; : > "$T/created.log"
bash "$here/publish-volume.sh" 2026-09-30 "$vd/assets" >/dev/null && [[ $(ls "$T/rel/data-volume-2026-09-30" | wc -l) == 2 ]] &&
  ok "publish-volume: release data-volume-DAY created with the CSV and its check" || no "publish-volume create"
bash "$here/publish-volume.sh" 2026-09-30 "$vd/assets" >/dev/null && [[ $(grep -c data-volume-2026-09-30 "$T/created.log") == 1 ]] &&
  ok "publish-volume: the same content again is accepted unchanged" || no "publish-volume rerun"
vrows 1124 > "$vd/assets/volume-hours-2026-09-30.csv"
out=$(bash "$here/publish-volume.sh" 2026-09-30 "$vd/assets" 2>&1) && no "publish-volume replaced a published release" ||
  { [[ "$out" == *"other content"* ]] && grep -q ',1123,' "$T/rel/data-volume-2026-09-30/volume-hours-2026-09-30.csv" && ok "publish-volume: other content fails, the release is not touched" || no "publish-volume other: $out"; }
rm -rf "$T/rel/data-volume-2026-09-30"
vrows | head -24 > "$vd/assets/volume-hours-2026-09-30.csv"
bash "$here/publish-volume.sh" 2026-09-30 "$vd/assets" >/dev/null 2>&1 && no "publish-volume published 23 hours" || ok "publish-volume: a CSV that is not 24 hours of the day publishes nothing"
vrows | sed '3s/,1$/,2/' > "$vd/assets/volume-hours-2026-09-30.csv"
bash "$here/publish-volume.sh" 2026-09-30 "$vd/assets" >/dev/null 2>&1 && no "publish-volume published covered=2" || ok "publish-volume: covered other than 0/1 publishes nothing"
vrows > "$vd/assets/volume-hours-2026-09-30.csv"; echo '{"mismatches": [{"x":1}], "problems": []}' > "$vd/assets/volume-check-2026-09-30.json"
bash "$here/publish-volume.sh" 2026-09-30 "$vd/assets" >/dev/null 2>&1 && no "publish-volume published a failed check" || ok "publish-volume: a cross-check with mismatches publishes nothing"
echo '{"mismatches": [], "problems": []}' > "$vd/assets/volume-check-2026-09-30.json"
FAKE_GH_ERROR=1 bash "$here/publish-volume.sh" 2026-09-30 "$vd/assets" >/dev/null 2>&1 && no "publish-volume treated a gh error as absent" ||
  { [[ ! -d "$T/rel/data-volume-2026-09-30" ]] && ok "publish-volume: a gh error other than 'release not found' fails, never publishes" || no "publish-volume gh error"; }
# volume-day.sh: back-fill from a published day's own units (no archive access)
V="$T/vbin"; mkdir -p "$V"
cat > "$V/zeroed-scan" <<'STUB'
#!/usr/bin/env bash
while (( $# )); do case "$1" in -dataset) ds=$2 ;; -from) from=$2 ;; -out) out=$2 ;; esac; shift; done
[[ -f "$out/units/1046/1-2/stats.json" ]] || { echo "units not extracted" >&2; exit 1; }
mkdir -p "$ds/days/$from"; cp "$T/vol-fixture.zst" "$ds/days/$from/volume_hours-000.csv.zst"
STUB
cat > "$V/node" <<STUB
#!/usr/bin/env bash
if [[ "\$2" == */volume.ts ]]; then mkdir -p "\$3/qa"; echo "\$4" > "\$T/volume.units"; echo '{"mismatches": [], "problems": []}' > "\$3/qa/volume.json"; exit 0; fi
exec "$REAL_NODE_DIR/node" "\$@"
STUB
chmod +x "$V"/*
cp "$vd/ds/days/2026-09-30/volume_hours-000.csv.zst" "$T/vol-fixture.zst"
mkvday() {
  local r="$T/rel/data-day-2026-09-30" u="$T/vday-src"
  rm -rf "$r" "$u"; mkdir -p "$r" "$u/units/1046/1-2"; echo '{"blocks":1}' > "$u/units/1046/1-2/stats.json"
  head -c 300000 /dev/urandom > "$u/units/1046/1-2/curve_trades.csv.zst"
  (cd "$u" && tar -cf - units) | split -b 200000 -d -a 2 - "$r/units-2026-09-30.tar.part"
  echo x > "$r/events-2026-09-30.tar"
  (cd "$r" && sha256sum units-2026-09-30.tar.part* events-2026-09-30.tar > SHA256SUMS-2026-09-30)
}
vday() {
  rm -rf "$T/vday-assets"
  GH_TOKEN=x bash "$here/volume-day.sh" --download 2026-09-30 "$T/vday-work" > "$T/out.txt" 2>&1 &&
    env -u GH_TOKEN PATH="$V:$PATH" bash "$here/volume-day.sh" 2026-09-30 "$T/vday-work" "$T/vday-assets" >> "$T/out.txt" 2>&1
}
mkvday
vday && cmp -s <(vrows) "$T/vday-assets/volume-hours-2026-09-30.csv" && [[ $(cat "$T/volume.units") == "$T/vday-work/data-2026-09-30/units" ]] &&
  ok "volume-day: a published day's tar parts are verified, extracted, finalized, cross-checked and turned into the volume asset" || no "volume-day: $(cat "$T/out.txt")"
mkvday; echo corrupt >> "$T/rel/data-day-2026-09-30/units-2026-09-30.tar.part01"
vday && no "volume-day used a corrupt part" || { [[ ! -e "$T/vday-assets/volume-hours-2026-09-30.csv" ]] && ok "volume-day: a part failing its checksum stops before any asset" || no "volume-day corrupt"; }
mkvday; rm "$T/rel/data-day-2026-09-30/units-2026-09-30.tar.part01"
vday && no "volume-day used an incomplete release" || { grep -q "differ from its SHA256SUMS" "$T/out.txt" && ok "volume-day: a missing part stops before extraction" || no "volume-day missing: $(cat "$T/out.txt")"; }
mkvday; rm -rf "$T/vday-work"; GH_TOKEN=x bash "$here/volume-day.sh" --download 2026-09-30 "$T/vday-work" >/dev/null 2>&1
GH_TOKEN=x PATH="$V:$PATH" bash "$here/volume-day.sh" 2026-09-30 "$T/vday-work" "$T/vday-assets" > "$T/out.txt" 2>&1 && no "volume-day rebuilt with a token in its environment" ||
  { grep -q "runs without GH_TOKEN" "$T/out.txt" && ok "volume-day: the rebuild refuses to run with GH_TOKEN set (the token stays in the download step)" || no "volume-day token: $(cat "$T/out.txt")"; }
rm -rf "$T/rel/data-day-2026-09-30"
unset GH_BIN

# ---- scanner-rev.sh: tree hash plus the Go version; another toolchain fails ----
G="$T/gobin"; mkdir -p "$G"; printf '#!/usr/bin/env bash\necho "${FAKE_GOVERSION}"\n' > "$G/go"; chmod +x "$G/go"
r1=$(cd "$here" && PATH="$G:$PATH" FAKE_GOVERSION=go1.24.7 GO_VERSION=1.24.7 bash "$here/scanner-rev.sh")
r2=$(cd "$here" && PATH="$G:$PATH" FAKE_GOVERSION=go1.24.8 GO_VERSION=1.24.8 bash "$here/scanner-rev.sh")
tree=$(cd "$here" && git rev-parse HEAD:research/historical/scanner)
[[ "$r1" == "$tree-go1.24.7" && "$r2" == "$tree-go1.24.8" ]] && ok "scanner-rev: a toolchain-only change gives a new revision ($r1 vs ...-go1.24.8)" || no "scanner-rev: $r1 / $r2"
(cd "$here" && PATH="$G:$PATH" FAKE_GOVERSION=go1.25.0 GO_VERSION=1.24.7 bash "$here/scanner-rev.sh" >/dev/null 2>&1) && no "scanner-rev accepted another toolchain" ||
  ok "scanner-rev: a toolchain other than go\$GO_VERSION fails the build"

# ---- data-scan.yml: a published day is skipped before any archive read; the token only in two clean steps ----
python3 - "$here/../../../.github/workflows/data-scan.yml" <<'PY' && ok "workflow: every step after the published check (scan, QA, store) is skipped for a complete day; the store token only in the check, store and storage-check steps, all in a clean shell; a resumable stop chains the next run, bounded, only after a saved progress; QA starts only with 45 min left" || no "workflow skip/token structure"
import sys, yaml
steps = yaml.safe_load(open(sys.argv[1]))["jobs"]["scan"]["steps"]
i = next(k for k, s in enumerate(steps) if s.get("id") == "published")
names = [s.get("name", s.get("uses", "")) for s in steps]
assert all("Scan" not in n and "Build" not in n for n in names[:i]), names[:i]
for s in steps[i + 1:]:
    if "setup-node" in s.get("uses", ""):
        continue
    assert "steps.published.outputs.complete != 'true'" in s.get("if", ""), s
gtok = [s.get("id") or s.get("name") for s in steps if "github.token" in str(s)]
assert gtok == ["pickprogress", "guardscan", "guardqa"], gtok
# OF-4: the store token as GH_TOKEN only in the skip, store, volume store and storage-check steps
tok = [s for s in steps if (s.get("env") or {}).get("GH_TOKEN") == "${{ secrets.DATA_STORE_TOKEN }}"]
assert [s.get("id") or s.get("name") for s in tok] == ["published", "prior", "margin", "store", "Store this day's volume hours", "Storage check after the batch"], tok
tok += [s for s in steps if (s.get("id") or s.get("name")) in ("guardscan", "guardqa")]
pick = next(s for s in steps if s.get("id") == "pickprogress")
assert pick["run"].endswith('research/historical/ci/progress-pick.sh" "$PREFIX"'), pick
for s in tok:
    assert s["shell"].startswith("/usr/bin/env -u BASH_ENV -u ENV /usr/bin/bash --noprofile --norc"), s
    assert s["env"]["BASH_ENV"] == "" and s["run"].startswith("/usr/bin/env -i PATH=/usr/bin:/bin "), s
    assert all(s["env"][k] == "" for k in ("LD_PRELOAD", "LD_AUDIT", "LD_LIBRARY_PATH")), s
for s in steps[i + 1:]:
    if "always()" in s.get("if", ""):
        assert "steps.published.outcome == 'success'" in s["if"], s
# chaining: the scan step reports exit 75 as resumable and a resume-DAY artifact follows;
# the continue job is one gh step with actions: write only, no checkout, a bounded chain,
# dispatched only when this run holds a resume-* artifact
wf = yaml.safe_load(open(sys.argv[1]))
scan = next(s for s in steps if s.get("id") == "scan")
assert '-eq 75 ]; then echo "resumable=true"' in scan["run"] and 'exit "$rc"' in scan["run"], scan
assert any(s.get("with", {}).get("name") == "resume-${{ matrix.day }}" for s in steps)
c = wf["jobs"]["continue"]
assert c["needs"] == ["plan", "scan"] and "needs.scan.result == 'failure'" in c["if"], c
# OF-2 round 2 (ruling 5): a read-only checkout so the step can run archive-guard.sh restarts
assert c["permissions"] == {"contents": "read", "actions": "write"} and int(c["env"]["MAX_CHAIN"]) <= 12, c
assert len(c["steps"]) == 2 and c["steps"][0]["uses"].startswith("actions/checkout@") and c["steps"][0]["with"]["persist-credentials"] is False, c
assert "uses" not in c["steps"][1], c
r = c["steps"][1]["run"]
assert r.index('select(startswith("resume-"))') < r.index('-ge "$MAX_CHAIN"') < r.index("gh workflow run"), r
assert '-f chain="$next"' in r and "-f days=\"$DAYS\"" in r, r
assert wf[True]["workflow_dispatch"]["inputs"]["chain"]["default"] == "0"
# volume back-fill: its own concurrency group, no archive access, token in two steps only,
# publishing in the same clean shell as the day release
assert wf["concurrency"]["group"] == "${{ inputs.mode == 'volume' && 'data-scan-volume' || (inputs.source == 'helius' && 'data-scan-helius' || 'data-scan') }}", wf["concurrency"]
assert wf["concurrency"]["cancel-in-progress"] is False, wf["concurrency"]
vj = wf["jobs"]["volume"]
assert vj["if"] == "inputs.mode == 'volume'" and vj["strategy"]["max-parallel"] == 1, vj
vsteps = vj["steps"]
assert not any("scan-day.sh" in str(st) or "zeroed-scan run" in str(st) or "zeroed-scan unit" in str(st) for st in vsteps), "the back-fill must not read the archive"
vtok = [st["name"] for st in vsteps if "secrets.DATA_STORE_TOKEN" in str(st)]
assert vtok == ["Download the day's units", "Store the volume hours"] and "github.token" not in str(vsteps), vtok
dl = next(st for st in vsteps if st.get("name") == "Download the day's units")
assert 'volume-day.sh" --download' in dl["run"] and "zeroed-scan" not in dl["run"] and "node" not in dl["run"], dl
rb = next(st for st in vsteps if st.get("name") == "Rebuild the day's volume hours from its units")
assert "GH_TOKEN" not in str(rb) and "--download" not in rb["run"], rb
assert vsteps.index(dl) < vsteps.index(rb) < vsteps.index(vsteps[-1])
pub = vsteps[-1]
assert pub["shell"].startswith("/usr/bin/env -u BASH_ENV -u ENV /usr/bin/bash --noprofile --norc") and pub["run"].startswith("/usr/bin/env -i PATH=/usr/bin:/bin ") and "publish-volume.sh" in pub["run"], pub
assert "volume" in wf[True]["workflow_dispatch"]["inputs"]["mode"]["options"]
# QA-phase budget: checked after the progress save and before QA, against this job's own
# timeout; QA, packaging and publishing never run on always(), so a stop skips them
names = [s.get("id") or s.get("name") or s.get("uses") for s in steps]
assert names[0] == "Record the job start (time budget of the QA phase)" and "JOB_START=" in steps[0]["run"]
qt = next(s for s in steps if s.get("id") == "qatime")
assert f'time-left.sh "$JOB_START" {wf["jobs"]["scan"]["timeout-minutes"]} ' in qt["run"] and '-eq 75 ]; then echo "resumable=true"' in qt["run"], qt
order = lambda key: names.index(key)
assert order("save") < order("qatime") < order("qa") < order("Package the day") < order("store")
for k in ("qa", "Package the day", "store"):
    st = steps[order(k)]
    assert "always()" not in st.get("if", ""), st
# chained only after a successful save, for either resumable stop
marks = [s for s in steps if "resumable" in s.get("if", "")]
assert len(marks) == 2, marks
for st in marks:
    assert "steps.save.outcome == 'success'" in st["if"] and "steps.qatime.outputs.resumable == 'true'" in st["if"] and "steps.scan.outputs.resumable == 'true'" in st["if"], st
assert order("Log the progress entry size") == order("save") - 1 and "du -sb" in steps[order("Log the progress entry size")]["run"]
# a 429 in the determinism rescan (check-day exit 75) is resumable too; the markers come after QA
qa = steps[order("qa")]
assert '-eq 75 ]; then echo "resumable=true"' in qa["run"] and 'exit "$rc"' in qa["run"], qa
for st in marks:
    assert "steps.qa.outputs.resumable == 'true'" in st["if"], st
    assert steps.index(st) > order("qa"), "resume markers must follow the QA step"
# phase durations: the store (OF-4: no day artifact) timed around its step
assert not any(st.get("with", {}).get("name") == "day-${{ matrix.day }}" for st in steps)
assert order("Note the store start") < order("store") < order("Log the store duration")
PY

# ---- rpcscan: the scanner's own sources through symlinks; the IDLs byte-identical ----
rs="$here/../rpcscan"; sc="$here/../scanner"; bad=""
for f in $(cd "$sc" && git ls-files '*.go' | grep -v '_test.go$' | grep -v '^main.go$') go.mod go.sum; do
  [[ -L "$rs/$f" && "$(readlink "$rs/$f")" == "../scanner/$f" ]] || bad+=" $f"
done
for f in "$rs"/*.go; do
  b=$(basename "$f"); [[ -L "$f" ]] && { [[ -e "$sc/$b" && "$b" != main.go && "$b" != *_test.go ]] || bad+=" stray-link:$b"; }
done
for f in $(cd "$sc/idl" && ls); do cmp -s "$sc/idl/$f" "$rs/idl/$f" || bad+=" idl/$f"; done
[[ -z "$bad" ]] && ok "rpcscan: every scanner source but main.go is a symlink to ../scanner (no copied decoder), and the embedded IDLs equal the scanner's" || no "rpcscan links:$bad"

# ---- data-helius-pilot.yml: dispatch only, a hard credit stop, the key in one step, only the report out ----
python3 - "$here/../../../.github/workflows/data-helius-pilot.yml" <<'PY' && ok "helius pilot workflow: dispatch only, read-only token, credit stop checked first (at most 15000), HELIUS_API_KEY only in the pilot step's env, inputs only through env, only the report uploaded" || no "helius pilot workflow structure"
import sys, yaml
wf = yaml.safe_load(open(sys.argv[1]))
assert list(wf[True].keys()) == ["workflow_dispatch"], wf[True]
assert wf["permissions"] == {"contents": "read"}, wf["permissions"]
steps = wf["jobs"]["pilot"]["steps"]
assert steps[0]["name"] == "Check the credit stop" and "MAX_CREDITS > 15000" in steps[0]["run"], steps[0]
for st in steps:
    if "checkout" in st.get("uses", ""):
        assert st["with"]["persist-credentials"] is False, st
    assert "${{" not in st.get("run", ""), st  # inputs and secrets reach the shell only through env
sec = [st for st in steps if "secrets." in str(st)]
assert len(sec) == 1 and sec[0]["env"] == {"HELIUS_API_KEY": "${{ secrets.HELIUS_API_KEY }}", "MAX_CREDITS": "${{ inputs.max_credits }}"}, sec
r = sec[0]["run"]
assert "zeroed-rpcscan pilot" in r and '-max-credits "$MAX_CREDITS"' in r and "-sample 0.05" in r and "HELIUS_API_KEY" not in r, r
up = [st for st in steps if "upload-artifact" in st.get("uses", "")]
assert len(up) == 1 and up[0]["with"]["path"].endswith("/report/pilot-report.json"), up
assert "github.token" not in open(sys.argv[1]).read()
PY

# ---- check-day.sh: phase durations; a 429 in the determinism rescan is resumable (75) ----
C="$T/cdbin"; mkdir -p "$C"
cat > "$C/zeroed-scan" <<'STUB'
#!/usr/bin/env bash
# finalize: an empty dataset with its manifest; unit (determinism rescan): exit RESCAN_RC
echo "$*" >> "$T/zs.args"
if [[ $1 == finalize ]]; then
  while (( $# )); do [[ "$1" == -dataset ]] && ds=$2; shift; done
  mkdir -p "$ds/qa"; echo '{}' > "$ds/manifest.json"; exit 0
fi
# RESCAN_COPY (OF-6 tests): the rescan writes the unit's own files, so the comparison passes
if [[ $1 == unit && -n "${RESCAN_COPY:-}" && "${RESCAN_RC:-0}" == 0 ]]; then
  while (( $# )); do case "$1" in -out) o=$2 ;; -state) st=$2 ;; -epoch) e=$2 ;; -from-slot) f=$2 ;; -to-slot) t=$2 ;; esac; shift; done
  mkdir -p "$o/units/$e/$f-$t"; cp "$st/units/$e/$f-$t"/*.zst "$o/units/$e/$f-$t/"
fi
exit "${RESCAN_RC:-0}"
STUB
cat > "$C/node" <<'STUB'
#!/usr/bin/env bash
# check.mjs and parity.ts stand-ins: write their reports into the dataset
for a in "$@"; do [[ -d "$a/qa" ]] && { echo r > "$a/qa/report.md"; echo '{}' > "$a/qa/report.json"; echo '{}' > "$a/qa/parity.json"; echo '{}' > "$a/qa/volume.json"; }; done
exit 0
STUB
chmod +x "$C"/*
# cdrun NAME RESCAN_RC: the armed fixture's check-day.sh for 2026-07-22 (CDAY overrides),
# one unit recording retention K2 (CDRET overrides; "none": no retention field), a
# fresh guard pass unless NOPASS.
cdrun() {
  local o="$T/cd-$1" d=${CDAY:-2026-07-22} r=${CDRET:-K2}; rm -rf "$o"; mkdir -p "$o/units/1046/1-2" "$o/cache" "$T/cd-ds"; echo x > "$o/units/1046/1-2/blocks.csv.zst"
  if [[ "$r" == none ]]; then echo '{"blocks": 3}' > "$o/units/1046/1-2/stats.json"; else printf '{"blocks": 3, "retention": "%s"}\n' "$r" > "$o/units/1046/1-2/stats.json"; fi
  : > "$T/summary.md"
  : > "$T/zs.args"
  [[ -n "${NOPASS:-}" ]] || gpass "$d" "${CDPASS:-$r}"
  ARCHIVE_GO=${ARCHIVE_GO:-$T/archive10.go} ARCHIVE_GUARD_DIR="$GP" RESCAN_RC=$2 FAKE_AVAIL=999000000000 DATASET_PARENT="$T/cd-ds" PATH="$C:$PATH" GITHUB_STEP_SUMMARY="$T/summary.md" \
    bash "${CFX:-$FX}/check-day.sh" "$d" "$o" "$T/cd-assets-$1" > "$T/out.txt" 2>&1
}
rc=0; t0=$(date +%s); cdrun a 75 || rc=$?
end=$(awk '{print $3}' "$T/cd-a/archive-429.state" 2>/dev/null || true)
[[ $rc == 4 ]] && (( ${end:-0} >= t0 + 10800 )) && grep -q "429 during the determinism rescan: back-off of at least 3 h; the chain stops" "$T/summary.md" &&
  ok "ARCHIVE-SAFE: check-day: a 429 in the determinism rescan holds a 3 h back-off and exits 4 (not resumable)" || no "check-day 429: rc=$rc end=$end $(cat "$T/out.txt")"
for p in finalize qa parity volume determinism; do grep -qE "^phase $p \(2026-07-22\): (passed|failed \(exit [0-9]+\)), [0-9]+ s" "$T/summary.md" || { no "check-day: no duration for $p"; break; }; done
u=$(grep '^unit ' "$T/zs.args")
[[ " $u " == *" -max-mbps 40 -dl 4 "* ]] && ok "ARCHIVE-SAFE: check-day's determinism rescan runs at -max-mbps 40 -dl 4 (archive-limits.conf)" || no "check-day rescan args: $u"
bad=""
for v in 41 0; do rc=0; MAX_MBPS=$v cdrun m 0 || rc=$?; [[ $rc == 2 && ! -s "$T/zs.args" ]] && grep -q "max_mbps $v is not in" "$T/summary.md" || bad+=" mbps=$v:$rc"; done
for g in archive40 archive10.5 archivenone; do rc=0; ARCHIVE_GO="$T/$g.go" cdrun m 0 || rc=$?; [[ $rc == 2 && ! -s "$T/zs.args" ]] && grep -q "request cap" "$T/summary.md" || bad+=" $g:$rc"; done
rc=0; MAX_MBPS=40 cdrun m 75 || rc=$?; [[ $rc == 4 ]] && grep -q '^unit ' "$T/zs.args" || bad+=" ok40:$rc"
o="$T/cd-nd"; rm -rf "$o"; mkdir -p "$o/units/1046/1-2" "$T/cd-ds"; echo x > "$o/units/1046/1-2/blocks.csv.zst"; : > "$T/zs.args"; : > "$T/summary.md"; rc=0
ARCHIVE_GO="$T/archive10.go" FAKE_AVAIL=999000000000 DATASET_PARENT="$T/cd-ds" PATH="$C:$PATH" GITHUB_STEP_SUMMARY="$T/summary.md" bash "$here/check-day.sh" 2026-09-21 "$o" "$T/cd-assets-nd" > "$T/out.txt" 2>&1 || rc=$?
[[ $rc == 2 && ! -s "$T/zs.args" ]] && grep -q "2026-09-21 is a Helius day" "$T/summary.md" || bad+=" helius-day:$rc"
[[ -z "$bad" ]] && ok "ARCHIVE-SAFE: check-day (archive) exits 2 before any zeroed-scan call for max_mbps 41 or 0, a request cap of 40, 10.5 or none, and a Helius day (ARCHIVE-NODUP); 40 MB/s at 10/s runs" || no "check-day limits:$bad"
[[ $p == determinism ]] && grep -q "^phase determinism" "$T/summary.md" && ok "check-day: finalize, QA, parity, volume and determinism durations are logged"
# OF-6: a built scanner is never committed: the default go build outputs are ignored, and
# (in a git checkout) no tracked file under research/historical is an executable binary.
bad=""
for f in scanner/scanner rpcscan/rpcscan scanner/zeroed-scan; do grep -qxF "$f" "$here/../.gitignore" || bad+=" [not ignored: $f]"; done
if git -C "$here" rev-parse --git-dir >/dev/null 2>&1; then
  while IFS= read -r -d '' f; do
    [[ -f "$here/../../../$f" && "$(head -c 4 "$here/../../../$f" | od -An -tx1 | tr -d ' \n')" == 7f454c46 ]] && bad+=" [tracked ELF binary: $f]"
  done < <(git -C "$here/../../.." ls-files -z research/historical)
fi
[[ -z "$bad" ]] && ok "OF-6: a built scanner (scanner/scanner, rpcscan/rpcscan, zeroed-scan) is ignored by git, and no tracked file under research/historical is an executable binary" || no "OF-6 no binary:$bad"
# OF-7: the one pinned B10-PULL row in docs/DECISIONS.md names the source, the frozen scanner
# revision (equal to the scanner in this tree, so a scanner change re-pins it), the allow-listed
# days, a past pinnedAt, the per-unit log, the 07-22 lead-in limit and the owner's decision.
bad=""
rev=""; git -C "$here" rev-parse --git-dir >/dev/null 2>&1 && rev=$(git -C "$here/../../.." rev-parse HEAD:research/historical/scanner 2>/dev/null || true)
python3 - "$here/../../../docs/DECISIONS.md" "$here/archive-limits.conf" "$here/../../../.github/workflows/data-scan.yml" "$rev" > "$T/b10pull.txt" 2>&1 <<'PY' || bad+=" [$(tail -1 "$T/b10pull.txt")]"
import re, sys, datetime
dec, conf, wf, tree = sys.argv[1:5]
rows = [l for l in open(dec) if re.match(r"\| \d{4}-\d{2}-\d{2} \| B10-PULL id=", l)]
assert len(rows) == 1, "%d B10-PULL rows" % len(rows)
r = rows[0]
m = re.match(r"\| \d{4}-\d{2}-\d{2} \| B10-PULL id=([A-Za-z0-9._:-]+) source=old-faithful scannerRev=([0-9a-f]{40})-go(\S+) days=(\S+) pinnedAt=(\S+) unitLog=units-D\.log ", r)
assert m, "row fields"
days = re.search(r'^ARCHIVE_DAYS="([^"]*)"', open(conf).read(), re.M).group(1)
assert m.group(4) == days, "days %s, ARCHIVE_DAYS %s" % (m.group(4), days)
gov = re.search(r'^  GO_VERSION: "?([0-9.]+)"?', open(wf).read(), re.M).group(1)
assert m.group(3) == gov, "go %s, data-scan.yml %s" % (m.group(3), gov)
if tree: assert m.group(2) == tree, "scannerRev %s, scanner tree %s: re-pin the row" % (m.group(2), tree)
t = datetime.datetime.strptime(m.group(5), "%Y-%m-%dT%H:%M:%SZ")
assert t <= datetime.datetime.now(datetime.timezone.utc).replace(tzinfo=None), "pinnedAt in the future"
assert "lacks the pools migrated on 07-21 from 19:00 UTC" in r and "07-22 is lead-in only" in r, "07-22 limit"
assert '"Old faithful but by batch to avoid blockage"' in r, "owner decision"
print("ok", m.group(1))
PY
grep -q '^ok b10pull-of-1$' "$T/b10pull.txt" || bad+=" [id]"
[[ -z "$bad" ]] && ok "OF-7: docs/DECISIONS.md holds one pinned B10-PULL row (source, scanner revision equal to this tree's scanner, ARCHIVE_DAYS, Go version, past pinnedAt, per-unit log, the 07-22 lead-in limit, the owner's decision)" || no "OF-7 B10-PULL row:$bad"
# OF-6: the rescan reads exactly one unit; a unit range longer than unitSlots is refused before any read.
bad=""
rc=0; RESCAN_COPY=1 cdrun o1 0 || rc=$?; [[ $rc == 0 && $(grep -c '^unit ' "$T/zs.args") == 1 ]] && grep -q -- "-from-slot 1 -to-slot 2 " "$T/zs.args" || bad+=" [one: $rc]"
mkdir -p "$T/cd-long/units/1046/1-9001" "$T/cd-long/cache"; echo x > "$T/cd-long/units/1046/1-9001/blocks.csv.zst"; printf '{"blocks": 3, "retention": "K2"}\n' > "$T/cd-long/units/1046/1-9001/stats.json"
: > "$T/zs.args"; : > "$T/summary.md"; gpass 2026-07-22 K2; rc=0
ARCHIVE_GO=$T/archive10.go ARCHIVE_GUARD_DIR="$GP" FAKE_AVAIL=999000000000 DATASET_PARENT="$T/cd-ds" PATH="$C:$PATH" GITHUB_STEP_SUMMARY="$T/summary.md" \
  bash "$FX/check-day.sh" 2026-07-22 "$T/cd-long" "$T/cd-assets-long" > "$T/out.txt" 2>&1 || rc=$?
[[ $rc == 2 ]] && ! grep -q '^unit ' "$T/zs.args" && grep -q "is not one unit" "$T/summary.md" || bad+=" [long: $rc $(tail -1 "$T/summary.md")]"
[[ -z "$bad" ]] && ok "OF-6: the determinism rescan reads exactly one unit; a unit range longer than unitSlots is refused before any read" || no "OF-6 rescan one unit:$bad"
rc=0; cdrun b 1 || rc=$?
[[ $rc == 1 ]] && grep -q "determinism rescan failed (scanner exit 1)" "$T/summary.md" && ok "check-day: any other rescan failure exits 1 (not resumable)" || no "check-day rescan failure: rc=$rc"

# ---- rpc-day.sh / rpc-credits.sh / check-day.sh (source helius): one credit total per day across runs ----
R="$T/rpcbin"; mkdir -p "$R"
cat > "$R/zeroed-rpcscan" <<'STUB'
#!/usr/bin/env bash
# rpc-run / rpc-unit stand-in: logs its arguments, writes RPC_CREDITS into -usage-out,
# sleeps RPC_SLEEP (interruptible: SIGINT writes the usage and exits 1), exits RPC_RC.
echo "$*" >> "$RPCLOG"
u=; while (( $# )); do [[ $1 == -usage-out ]] && u=$2; shift; done
w() { [[ -n "$u" && -z "${RPC_NOUSAGE:-}" ]] || return 0
  if [[ -n "${RPC_USAGE_RAW:-}" ]]; then printf '%s' "$RPC_USAGE_RAW" > "$u"; else printf '{\n  "credits": %s,\n  "requests": 1\n}\n' "${RPC_CREDITS:-0}" > "$u"; fi; }
trap 'w; exit 1' INT
[[ -n "${RPC_SLEEP:-}" ]] && { sleep "$RPC_SLEEP" 2>/dev/null & wait $!; }
[[ -n "${RPC_ERR:-}" ]] && echo "$RPC_ERR" >&2
w; exit "${RPC_RC:-0}"
STUB
chmod +x "$R/zeroed-rpcscan"
rd() { local o=$1; shift; : > "$T/summary.md"; env RPCLOG="$T/rpc.log" PATH="$R:$PATH" GITHUB_STEP_SUMMARY="$T/summary.md" "$@" \
  bash "$here/rpc-day.sh" 2026-09-21 "$o" "${RD_BUDGET:-5}" 1000 > "$T/out.txt" 2>&1; }
o="$T/rd1"; rm -rf "$o" "$T/rpc.log"
rc=0; rd "$o" RPC_CREDITS=100 RPC_RC=75 || rc=$?
[[ $rc == 75 && $(cat "$o/rpc-credits-used") == 100 ]] && grep -q -- "-max-credits 1000 " "$T/rpc.log" && grep -q -- "-from 2026-09-21 -to 2026-09-22 " "$T/rpc.log" &&
  ok "rpc-day: a back-off stop exits 75 (resumable) and books the run's credits" || no "rpc-day 75: rc=$rc $(cat "$T/out.txt")"
rc=0; rd "$o" RPC_CREDITS=50 RPC_RC=0 || rc=$?
[[ $rc == 0 && $(cat "$o/rpc-credits-used") == 150 ]] && grep -q -- "-max-credits 900 " "$T/rpc.log" &&
  ok "rpc-day: the next chained run may spend only what is left of the day's cap (900 of 1000), and the total adds up" || no "rpc-day resume: rc=$rc $(cat "$T/rpc.log")"
rc=0; rd "$o" RPC_CREDITS=850 RPC_RC=3 || rc=$?
[[ $rc == 3 && $(cat "$o/rpc-credits-used") == 1000 ]] && grep -q "credit cap 1000 spent while reading" "$T/summary.md" &&
  ok "rpc-day: the cap spent mid-run exits 3 (not resumable) with the credits booked" || no "rpc-day cap: rc=$rc"
n=$(wc -l < "$T/rpc.log"); rc=0; rd "$o" || rc=$?
[[ $rc == 3 && $(wc -l < "$T/rpc.log") == "$n" ]] && ok "rpc-day: with the cap spent, no request is made (exit 3)" || no "rpc-day spent: rc=$rc"
# ARCHIVE-NODUP: only a day listed in HELIUS_DAYS is read over RPC.
o="$T/rdnd"; rm -rf "$o"; n=$(wc -l < "$T/rpc.log"); : > "$T/summary.md"; rc=0
env RPCLOG="$T/rpc.log" PATH="$R:$PATH" GITHUB_STEP_SUMMARY="$T/summary.md" bash "$here/rpc-day.sh" 2026-09-20 "$o" 5 1000 > "$T/out.txt" 2>&1 || rc=$?
[[ $rc == 2 && $(wc -l < "$T/rpc.log") == "$n" ]] && grep -q "2026-09-20 is not a Helius day" "$T/summary.md" &&
  ok "ARCHIVE-NODUP: rpc-day refuses a day not in HELIUS_DAYS (an archive-queue day) before any request (exit 2)" || no "rpc-day non-helius day: rc=$rc"
o="$T/rd2"; rm -rf "$o"; mkdir -p "$o/units/1046/1-2"; echo '{"scanner_revision": "old"}' > "$o/units/1046/1-2/stats.json"
rc=0; rd "$o" SCANNER_REVISION=new RPC_CREDITS=1 || rc=$?
[[ $rc == 0 && ! -e "$o/units/1046/1-2" ]] && ok "rpc-day: units of another revision are reread" || no "rpc-day revision"
o="$T/rd3"; rm -rf "$o"; t0=$(date +%s); rc=0; RD_BUDGET=2s rd "$o" RPC_SLEEP=30 RPC_CREDITS=7 || rc=$?
[[ $rc == 75 && $(cat "$o/rpc-credits-used") == 7 ]] && (( $(date +%s) - t0 < 20 )) &&
  ok "rpc-day: at the time budget the read is interrupted, its credits booked, exit 75" || no "rpc-day budget: rc=$rc $(cat "$T/out.txt")"
o="$T/rd4"; rm -rf "$o"; rc=0; rd "$o" RPC_USAGE_RAW='{"cre' RPC_RC=75 || rc=$?
[[ $rc != 0 && $rc != 75 ]] && grep -q "not booked" "$T/summary.md" &&
  ok "rpc-day: credits that cannot be booked (malformed usage file) stop the day, not resumable (exit $rc, never 75)" || no "rpc-day unbooked: rc=$rc $(cat "$T/out.txt")"
o="$T/rd5"; rm -rf "$o"; rc=0; rd "$o" RPC_CREDITS=100 RPC_RC=75 || rc=$?; rd "$o" RPC_NOUSAGE=1 RPC_RC=75 || true
[[ $(cat "$o/rpc-credits-used") == 100 ]] && ok "rpc-day: a run that writes no usage file books nothing (the previous run's file is not counted again)" || no "rpc-day stale usage: $(cat "$o/rpc-credits-used")"
printf '{\n  "requests": 3\n}\n' > "$T/bad-usage.json"; mkdir -p "$T/rc0"
"$here/rpc-credits.sh" add "$T/rc0" "$T/bad-usage.json" 2>/dev/null && no "rpc-credits accepted a usage file without credits" || ok "rpc-credits: a usage file without credits fails (never drops spent credits)"
# check-day, source helius: the determinism rescan goes over RPC within the day's cap
cdh() {
  local o="$T/cdh-$1"; rm -rf "$o"; mkdir -p "$o/units/1046/1-2" "$T/cd-ds"; echo x > "$o/units/1046/1-2/blocks.csv.zst"
  [[ -n "${2:-}" ]] && echo "$2" > "$o/rpc-credits-used"
  : > "$T/summary.md"; rm -f "$T/rpc.log"
  env SOURCE=helius RPC_CREDIT_CAP=500 RPCLOG="$T/rpc.log" FAKE_AVAIL=999000000000 DATASET_PARENT="$T/cd-ds" PATH="$R:$C:$PATH" GITHUB_STEP_SUMMARY="$T/summary.md" "${@:3}" \
    bash "$here/check-day.sh" 2026-09-20 "$o" "$T/cdh-assets-$1" > "$T/out.txt" 2>&1
}
rc=0; cdh a 200 RPC_CREDITS=40 RESCAN_RC=1 || rc=$?
[[ $(cat "$T/cdh-a/rpc-credits-used") == 240 ]] && grep -q -- "rpc-unit .*-epoch 1046 -from-slot 1 -to-slot 2 .*-max-credits 300 " "$T/rpc.log" &&
  ok "check-day (helius): the determinism rescan is an RPC rpc-unit within what is left of the cap, its credits booked" || no "check-day helius rescan: rc=$rc $(cat "$T/rpc.log" 2>/dev/null) $(tail -3 "$T/out.txt")"
rc=0; cdh b 500 || rc=$?
[[ $rc == 3 && ! -s "$T/rpc.log" ]] && ok "check-day (helius): with the cap spent, no rescan request and exit 3" || no "check-day helius cap: rc=$rc"
rc=0; cdh c 0 RPC_RC=75 || rc=$?
[[ $rc == 75 ]] && grep -q "RPC rate-limit back-off ran out during the determinism rescan" "$T/summary.md" && ok "check-day (helius): an RPC back-off stop in the rescan is resumable (75)" || no "check-day helius 75: rc=$rc"

# ---- time-left.sh: a phase starts only when it fits before the job timeout ----
now=$(date +%s); : > "$T/summary.md"
GITHUB_STEP_SUMMARY="$T/summary.md" bash "$here/time-left.sh" $((now - 300 * 60)) 355 45 >/dev/null && ok "time-left: 55 min left, 45 needed: the phase runs" || no "time-left enough"
rc=0; GITHUB_STEP_SUMMARY="$T/summary.md" bash "$here/time-left.sh" $((now - 320 * 60)) 355 45 >/dev/null || rc=$?
[[ $rc == 75 ]] && grep -q "45 needed: stopping before this phase" "$T/summary.md" && ok "time-left: 35 min left, 45 needed: exit 75 (resumable) and a summary line" || no "time-left short: rc=$rc"
rc=0; bash "$here/time-left.sh" x 355 45 >/dev/null 2>&1 || rc=$?
[[ $rc == 2 ]] && ok "time-left: a bad argument is refused (exit 2), never read as time left" || no "time-left bad arg: rc=$rc"

# ---- disk-guard.sh ----
dg=$(FAKE_AVAIL=24000000000 bash "$here/disk-guard.sh" "$T" 24000000000 "the scan" 2>&1) && [[ "$dg" == *"24.0 GB free"* ]] &&
  ok "disk-guard: passes at exactly the needed free space and logs it" || no "disk-guard pass: $dg"
dg=$(FAKE_AVAIL=23999999999 bash "$here/disk-guard.sh" "$T" 24000000000 "the scan" 2>&1) && no "disk-guard passed one byte short" ||
  { [[ "$dg" == *"not enough disk"*"the scan"* ]] && ok "disk-guard: fails one byte short with a clear message" || no "disk-guard message: $dg"; }

# ---- archive-check.sh: holds 1-7 before one request with the scanner's agent; dispatch only after a served check, never while a scan runs ----
A="$T/ac"; mkdir -p "$A/bin"
cat > "$A/bin/curl" <<'SH'
#!/usr/bin/env bash
printf '%s\n' "$@" > "$AC/curl.args"; echo x >> "$AC/curl.calls"
hdr=; while (( $# )); do [[ $1 == -D ]] && hdr=$2; shift; done
[[ "$AC_STATUS" == 000 ]] && exit 7
{ printf 'HTTP/2 %s\r\ncf-ray: 8abc123-SYD\r\n' "$AC_STATUS"; [[ -n "${AC_RA:-}" ]] && printf 'retry-after: %s\r\n' "$AC_RA"; printf '\r\n'; } > "$hdr"
head -c "${AC_BYTES:-64}" /dev/zero
exit "${AC_EXIT:-0}"
SH
chmod +x "$A/bin/"*
# ac [env VAR=...]: one scheduled check of the fixture (ACFX overrides), as the workflow
# runs it: the holds; when ready, the probe step (exit 1 unless served); a Retry-After
# recorded as cache key archive-backoff-<end>; on served the marker saved to the cache
# stub (default branch, run 900) and `--dispatch DAY`. The cache stub is emptied first
# unless KEEPCACHE is set. ACRC holds the probe step's exit code ("" when it did not run).
ac() { rm -f "$A/curl.calls" "$A/curl.args" "$GD/dispatch.log" "$GD/gh.log" "$A/output"; : > "$A/summary.md"; ACRC=""
  [[ -n "${KEEPCACHE:-}" ]] || rm -f "$GD/caches.json"
  local rc=0 day
  local base=(GD="$GD" AC="$A" GH_BIN="$GD/bin/gh" CURL_BIN="$A/bin/curl" GH_REPO=o/r REF=main DATA_REPO=o/data DATA_STORE_TOKEN=tok GH_TOKEN=ghtok
    GITHUB_REF=refs/heads/main GITHUB_RUN_ID=900 GITHUB_RUN_ATTEMPT=1 GITHUB_OUTPUT="$A/output" RUNNER_TEMP="$A/rt" GITHUB_STEP_SUMMARY="$A/summary.md")
  env "${base[@]}" "$@" bash "${ACFX:-$FX}/archive-check.sh" > "$A/out.txt" 2>&1 || rc=$?
  grep -qx ready=true "$A/output" 2>/dev/null || return $rc
  day=$(sed -n 's/^day=//p' "$A/output")
  ACRC=0; env "${base[@]}" "$@" bash "${ACFX:-$FX}/archive-check.sh" --probe "$day" >> "$A/out.txt" 2>&1 || ACRC=$?
  if grep -q '^backoff_end=' "$A/output"; then addcache "archive-backoff-$(sed -n 's/^backoff_end=//p' "$A/output")-900" refs/heads/main; fi
  if grep -qx served=true "$A/output"; then
    addcache "$(sed -n 's/^marker=//p' "$A/output")" refs/heads/main
    env "${base[@]}" "$@" bash "${ACFX:-$FX}/archive-check.sh" --dispatch "$day" >> "$A/out.txt" 2>&1 || rc=$?
  fi
  return $rc
}
addcache() { python3 - "$GD/caches.json" "$1" "$2" <<'PY'
import json, os, sys
p = sys.argv[1]
c = json.load(open(p)) if os.path.exists(p) else {"actions_caches": []}
c["actions_caches"].append({"key": sys.argv[2], "ref": sys.argv[3]})
json.dump(c, open(p, "w"))
PY
}
acruns() { if [[ $# -gt 0 ]]; then runs "$@" > "$GD/ds.json"; else rm -f "$GD/ds.json"; fi; }
ua=$(sed -n 's/^const userAgent = "\(.*\)"$/\1/p' "$here/../scanner/archive.go")
# Active runs by title (data-scan.yml's run-name): helius-only, archive, a run from before
# run-name ("data-scan"), the volume mode, anything unexpected. Completed ones ended 2 days ago.
runs() { python3 -c '
import json, sys, datetime
old = (datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(days=2)).strftime("%Y-%m-%dT%H:%M:%SZ")
print(json.dumps([{"databaseId": 100 + i, "status": a.split("|")[0], "conclusion": "success" if a.split("|")[0] == "completed" else None, "createdAt": old, "updatedAt": old, "attempt": 1, "headBranch": "main", "displayTitle": a.split("|")[1]} for i, a in enumerate(sys.argv[1:])]))' "$@"; }
gdreset
H="in_progress|data-scan scan source=helius"
bad=""
for set in "in_progress|data-scan scan source=archive" "queued|data-scan scan source=archive" "in_progress|data-scan" "queued|data-scan volume source=archive" \
           "in_progress|data-scan scan source=helius2" "in_progress|data-scan scan source=helius " "$H;in_progress|data-scan" "$H;queued|data-scan scan source=archive"; do
  IFS=';' read -ra a <<< "$set"
  acruns "${a[@]}" "completed|data-scan scan source=archive"; ac env AC_STATUS=206
  [[ ! -e "$A/curl.calls" && ! -e "$GD/dispatch.log" ]] && grep -q "may read the archive active or queued; no request made" "$A/summary.md" || bad+=" [$set]"
done
[[ -z "$bad" ]] && ok "archive-check: a run that may read the archive (archive source, no source in its title, anything unexpected) means no request and no dispatch" || no "archive-check archive-run no-op:$bad"
bad=""
for set in "$H" "queued|data-scan scan source=helius" "$H;queued|data-scan scan source=helius"; do
  IFS=';' read -ra a <<< "$set"
  acruns "${a[@]}" "completed|data-scan scan source=archive"; ac env AC_STATUS=206
  [[ $(wc -l < "$A/curl.calls" 2>/dev/null) == 1 && $(wc -l < "$GD/dispatch.log" 2>/dev/null) == 1 ]] && grep -q "served; dispatched data-scan for" "$A/summary.md" || bad+=" [$set]"
  grep -q 'gh api --paginate repos/o/r/actions/workflows/data-scan.yml/runs?created=[0-9TZ:-]*\.\.[0-9TZ:-]*&per_page=100 --jq' "$GD/gh.log" || bad+=" [list-call]"
done
acruns "$H"; ac env AC_STATUS=429
[[ $(wc -l < "$A/curl.calls") == 1 && ! -e "$GD/dispatch.log" ]] && grep -q "not served" "$A/summary.md" || bad+=" [429]"
# helius_runs (manual dispatch): an old-title run named by id counts as Helius-only (ids
# are 100, 101, ... in list order).
acruns "in_progress|data-scan" "in_progress|data-scan"; ac env AC_STATUS=206 HELIUS_RUNS=100,101
[[ $(wc -l < "$A/curl.calls" 2>/dev/null) == 1 && $(wc -l < "$GD/dispatch.log" 2>/dev/null) == 1 ]] || bad+=" [named]"
# The ARCHIVE-SAFE hold still applies beside a Helius run: a scanner capped above 10/s
# (the old 40, a test copy) holds before any request.
sed 's/^var reqLimiter = newLimiter([0-9.]*)$/var reqLimiter = newLimiter(40)/' "$here/../scanner/archive.go" > "$A/archive40.go"
acruns "$H"; ac env AC_STATUS=206 ARCHIVE_GO="$A/archive40.go"
[[ ! -e "$A/curl.calls" && ! -e "$GD/dispatch.log" ]] && grep -q "held (4):" "$A/summary.md" || bad+=" [hold-beside-helius]"
acruns "in_progress|data-scan" "queued|data-scan scan source=archive"; ac env AC_STATUS=206 HELIUS_RUNS=100
[[ ! -e "$A/curl.calls" && ! -e "$GD/dispatch.log" ]] && grep -q "may read the archive active or queued; no request made" "$A/summary.md" || bad+=" [named-but-archive-active]"
acruns "in_progress|data-scan"; ac env AC_STATUS=206 HELIUS_RUNS=999,1000
[[ ! -e "$A/curl.calls" ]] || bad+=" [other-id]"
acruns "in_progress|data-scan"; ac env AC_STATUS=206 HELIUS_RUNS=10
[[ ! -e "$A/curl.calls" ]] || bad+=" [prefix-id]"
for v in "100;x" "100 101" "abc" "100," ",100" "1e3" '$(id)'; do
  rc=0; acruns "in_progress|data-scan"; ac env AC_STATUS=206 HELIUS_RUNS="$v" || rc=$?
  [[ $rc == 1 && ! -e "$A/curl.calls" && ! -e "$GD/gh.log" ]] && grep -q "helius_runs must be run ids" "$A/summary.md" || bad+=" [refuse:$v]"
done
[[ -z "$bad" ]] && ok "ARCHIVE-LANE: only Helius runs active or queued (title source=helius, or an id named in helius_runs; anything else refused or blocking): exactly one request, and a served answer dispatches the archive day beside them (the ARCHIVE-SAFE hold still applies)" || no "archive-check helius-only:$bad"
acruns; ac env AC_STATUS=429
[[ $(wc -l < "$A/curl.calls") == 1 && ! -e "$GD/dispatch.log" ]] && grep -qx -- "-A" "$A/curl.args" && grep -qxF -- "$ua" "$A/curl.args" &&
  grep -qx -- "0-63" "$A/curl.args" && grep -q "| 429 | 64 | 0 | 8abc123-SYD |" "$A/summary.md" && [[ -n "$ua" ]] && grep -qx served=false "$A/output" &&
  ok "archive-check: a 429 makes exactly one 64-byte request with the scanner's agent, logs status and cf-ray, dispatches nothing, and sets served=false (the counted failure)" || no "archive-check 429"
# ARCHIVE-SAFE hold (4): with the scanner's request cap above 10/s (the old 40, a test
# copy), nothing is sent and nothing dispatched; the real scanner (10/s, #214) dispatches.
grep -qx 'var reqLimiter = newLimiter(10)' "$here/../scanner/archive.go" || no "scanner/archive.go request cap is not the literal newLimiter(10)"
ac env AC_STATUS=206 ARCHIVE_GO="$A/archive40.go"
[[ ! -e "$A/curl.calls" && ! -e "$GD/dispatch.log" ]] && grep -q "held (4): the scanner's request cap (40/s, scanner/archive.go) is above 10/s" "$A/summary.md" &&
  ok "ARCHIVE-SAFE: a scanner request cap of 40/s is above 10/s: held before any request, nothing dispatched" || no "archive-check hold: $(cat "$A/summary.md")"
sed 's/^var reqLimiter = newLimiter([0-9.]*)$/var reqLimiter = newLimiter(10.5)/' "$here/../scanner/archive.go" > "$A/archive105.go"
grep -v '^var reqLimiter' "$here/../scanner/archive.go" > "$A/archivenone.go"
bad=""
for g in archive105 archivenone; do ac env AC_STATUS=206 ARCHIVE_GO="$A/$g.go"; [[ ! -e "$A/curl.calls" && ! -e "$GD/dispatch.log" ]] && grep -q "held (4):" "$A/summary.md" || bad+=" $g"; done
[[ -z "$bad" ]] && ok "ARCHIVE-SAFE: a cap of 10.5/s or no cap found is held too" || no "archive-check hold variants:$bad"
ac env AC_STATUS=206
[[ $(wc -l < "$A/curl.calls") == 1 && $(wc -l < "$GD/dispatch.log") == 1 ]] &&
  grep -q -- "data-scan.yml --repo o/r --ref main -f mode=scan -f days=2026-07-22 -f max_mbps=40$" "$GD/dispatch.log" &&
  ok "OF-2: a 206 dispatches once: the first allow-listed day, 2026-07-22, at 40 MB/s" || no "archive-check 206 dispatch: $(cat "$GD/dispatch.log" 2>/dev/null)"
# OF-2 day order: day D+1 only after day D is read done in the private store.
echo 2026-07-23 > "$GD/published"; ac env AC_STATUS=206
grep -q -- "-f days=2026-07-22 " "$GD/dispatch.log" 2>/dev/null || bad+=" [d-not-stored]"
echo 2026-07-22 > "$GD/published"; ac env AC_STATUS=206
grep -q -- "-f days=2026-07-23 " "$GD/dispatch.log" 2>/dev/null || bad+=" [d-stored]"
printf '2026-07-22-k3\n' > "$GD/published"; ac env AC_STATUS=206
grep -q -- "-f days=2026-07-23 " "$GD/dispatch.log" 2>/dev/null || bad+=" [k3-read-done]"
[[ -z "${bad:-}" ]] && ok "OF-2: day D not read done in the store (07-22, with 07-23 stored) → 07-22 again, never 07-23; once 07-22 (or 07-22-k3) is stored, 07-23" || no "OF-2 day order:$bad"
bad=""
# Every allow-listed day read done: nothing is sent at all; the Helius day and the holdout
# days are never queued.
d=2026-07-22; : > "$GD/published"; while [[ ! "$d" > 2026-08-21 ]]; do echo "$d" >> "$GD/published"; d=$(date -u -d "$d + 1 day" +%F); done
mkfx "$T/fxk3" ARCHIVE_RETENTION=K3
ACFX=$T/fxk3/research/historical/ci ac env AC_STATUS=206
[[ ! -e "$A/curl.calls" && ! -e "$GD/dispatch.log" ]] && grep -q "every allow-listed day is read done; no request made" "$A/summary.md" &&
  ok "OF-2: with all 31 allow-listed days (30 days; 31 with the 07-22 lead-in) read done nothing is sent: 09-21 (Helius), the holdout days and days before 07-22 are never queued" || no "archive-check queue empty: $(cat "$A/summary.md")"
rm -f "$GD/published"
ac env AC_STATUS=206 AC_BYTES=65
[[ ! -e "$GD/dispatch.log" ]] && grep -qx served=false "$A/output" && ok "archive-check: a 206 of more than 64 bytes is not served" || no "archive-check oversized 206"
ac env AC_STATUS=206 AC_EXIT=18
[[ ! -e "$GD/dispatch.log" ]] && grep -q "| 206 | 64 | 18 |" "$A/summary.md" && ok "archive-check: a 206 whose transfer failed (curl exit kept across the pipe) is not served" || no "archive-check 206 with curl error: $(cat "$A/summary.md")"
ac env AC_STATUS=200
[[ ! -e "$GD/dispatch.log" ]] && grep -qx served=false "$A/output" && ok "archive-check: a 200 is not served, whatever its size" || no "archive-check 200"
ac env AC_STATUS=000
[[ $(wc -l < "$A/curl.calls") == 1 && ! -e "$GD/dispatch.log" ]] && grep -qx served=false "$A/output" && ok "archive-check: a network failure dispatches nothing and is counted" || no "archive-check failure"

# OF-1 (#214 on top of OF-2): with the real scanner/archive.go (10/s), armed and served
# → days=2026-07-22; unarmed (today's archive-limits.conf) → no request; 2026-09-20 is
# never dispatched, whatever is stored.
gdreset; bad=""
mkfx "$T/fxreal"; cp "$here/../scanner/archive.go" "$T/fxreal/research/historical/scanner/archive.go"
ACFX=$T/fxreal/research/historical/ci ac env AC_STATUS=206
[[ $(wc -l < "$A/curl.calls" 2>/dev/null) == 1 && $(wc -l < "$GD/dispatch.log" 2>/dev/null) == 1 ]] &&
  grep -q -- "-f mode=scan -f days=2026-07-22 -f max_mbps=40$" "$GD/dispatch.log" || bad+=" armed"
mkfx "$T/fxrealu" ARCHIVE_ARM=; cp "$here/../scanner/archive.go" "$T/fxrealu/research/historical/scanner/archive.go"
ACFX=$T/fxrealu/research/historical/ci ac env AC_STATUS=206
[[ ! -e "$A/curl.calls" && ! -e "$GD/dispatch.log" ]] || bad+=" unarmed"
d=2026-07-22; : > "$GD/published"; while [[ ! "$d" > 2026-09-19 ]]; do echo "$d" >> "$GD/published"; d=$(date -u -d "$d + 1 day" +%F); done
mkfx "$T/fxrealk3" ARCHIVE_RETENTION=K3; cp "$here/../scanner/archive.go" "$T/fxrealk3/research/historical/scanner/archive.go"
ACFX=$T/fxrealk3/research/historical/ci ac env AC_STATUS=206
[[ ! -e "$A/curl.calls" && ! -e "$GD/dispatch.log" ]] || bad+=" 09-20:$(cat "$GD/dispatch.log" 2>/dev/null)"
rc=0; GD="$GD" GH_BIN="$GD/bin/gh" GH_REPO=o/r REF=main GITHUB_STEP_SUMMARY="$A/summary.md" bash "$T/fxrealk3/research/historical/ci/archive-check.sh" --dispatch 2026-09-20 > "$A/out.txt" 2>&1 || rc=$?
[[ $rc == 1 && ! -e "$GD/dispatch.log" ]] || bad+=" dispatch-09-20:$rc"
[[ -z "$bad" ]] && ok "OF-1: with the real scanner (10/s) armed and served → days=2026-07-22; unarmed → no request; 2026-09-20 is never dispatched (queue or --dispatch)" || no "OF-1:$bad"
bad=""

# ---- OF-2 holds 1-3, 5-7 in archive-check (each: no request at all) ----
gdreset
rc=0; ACFX=$here ac env AC_STATUS=206 || rc=$?
[[ ! -e "$A/curl.calls" && ! -e "$GD/dispatch.log" ]] && grep -q "held (1): the archive chain is not armed (ARCHIVE_ARM is empty" "$A/summary.md" &&
  ok "OF-2 hold 1: today's archive-limits.conf (ARCHIVE_ARM empty) is unarmed: no request, no dispatch" || no "OF-2 unarmed: $(cat "$A/summary.md")"
mkfx "$T/fxother" ARCHIVE_ARM=b10pull-test-2
ACFX=$T/fxother/research/historical/ci ac env AC_STATUS=206
[[ ! -e "$A/curl.calls" && ! -e "$GD/dispatch.log" ]] && grep -q "held (1): the archive chain is not armed (ARCHIVE_ARM 'b10pull-test-2' is not the one pinned B10-PULL id 'b10pull-test-1'" "$A/summary.md" &&
  ok "OF-2 hold 1: armed with a different id than the pinned B10-PULL row → no request" || no "OF-2 other id: $(cat "$A/summary.md")"
mkfx "$T/fxtwo"; printf '| 2026-10-09 | B10-PULL id=b10pull-test-9 source=old-faithful scannerRev=r1 days=x pinnedAt=y | t | t |\n' >> "$T/fxtwo/docs/DECISIONS.md"
ACFX=$T/fxtwo/research/historical/ci ac env AC_STATUS=206
mkfx "$T/fxnopin"; : > "$T/fxnopin/docs/DECISIONS.md"
cp "$A/summary.md" "$A/summary-two.md"; ACFX=$T/fxnopin/research/historical/ci ac env AC_STATUS=206
[[ ! -e "$A/curl.calls" ]] && grep -q "held (1)" "$A/summary-two.md" && grep -q "held (1)" "$A/summary.md" &&
  ok "OF-2 hold 1: two different pinned B10-PULL ids, or none, are unarmed" || no "OF-2 pin variants"
# 2: back-off from run history: a block (a data-scan archive batch whose scan job failed
# and whose continue job did not chain it) 61 min ago, a non-served check 2 h ago.
now=$(date -u +%s)
dsrun 301 "data-scan scan source=archive" failure 300 61 "scan (2026-07-22)=failure,continue=failure" | dsjson
ac env AC_STATUS=206
[[ ! -e "$A/curl.calls" && ! -e "$GD/dispatch.log" ]] && grep -q "held (2): back-off: nothing goes out before" "$A/summary.md" &&
  ok "OF-2 hold 2: a block 61 min ago (batch exit 4, not chained) → no request" || no "OF-2 block 61 min: $(cat "$A/summary.md")"
rm -f "$GD/ds.json"; acrun 501 failure 120 notserved | acjson
ac env AC_STATUS=206
[[ ! -e "$A/curl.calls" ]] && grep -q "held (2): back-off" "$A/summary.md" &&
  ok "OF-2 hold 2: a non-206 check 2 h ago → no request" || no "OF-2 non-206 2 h: $(cat "$A/summary.md")"
acrun 501 failure 181 notserved | acjson
ac env AC_STATUS=206
[[ $(wc -l < "$A/curl.calls" 2>/dev/null) == 1 ]] &&
  ok "OF-2 hold 2: a non-206 check 3 h 1 min ago → the back-off is over, one request" || no "OF-2 back-off over: $(cat "$A/summary.md")"
acrun 502 failure 120 | acjson
ac env AC_STATUS=206
[[ $(wc -l < "$A/curl.calls" 2>/dev/null) == 1 ]] &&
  ok "OF-2: a failed archive-check run without the counted step (an error, not an answer) is not a failure" || no "OF-2 failed check not counted"
rm -f "$GD/ac.json"
dsrun 302 "data-scan scan source=archive" failure 300 61 "scan (2026-07-22)=failure,continue=success" | dsjson
ac env AC_STATUS=206
[[ $(wc -l < "$A/curl.calls" 2>/dev/null) == 1 ]] &&
  ok "OF-2: a batch that stopped resumably and was chained (continue succeeded) is not a failure" || no "OF-2 chained not counted: $(cat "$A/summary.md")"
rc=0; ac env AC_STATUS=206 GD_RUNS_FAIL=1 || rc=$?
[[ ! -e "$A/curl.calls" ]] && grep -q "held (2): the run history cannot be read" "$A/summary.md" &&
  ok "OF-2 hold 2: an unreadable run history → no request (fail closed)" || no "OF-2 history unreadable"
# 3: three failures (a block, a QA failure, a second exit 75: continue failed) count from
# ARCHIVE_REARM_AT, with no successful batch after them; all older than the back-off.
rm -f "$GD/ds.json"
{ dsrun 311 "data-scan scan source=archive" failure 500 420 "scan (2026-07-22)=failure,continue=failure"
  dsrun 312 "data-scan scan source=archive" failure 400 360 "scan (2026-07-22)=failure,continue=failure"
  dsrun 313 "data-scan scan source=archive" cancelled 320 300 "scan (2026-07-22)=cancelled"; } | dsjson
mkfx "$T/fxr8" ARCHIVE_REARM_AT="$(iso $(( now - 8 * 3600 )))"
ACFX=$T/fxr8/research/historical/ci ac env AC_STATUS=206
[[ ! -e "$A/curl.calls" && ! -e "$GD/dispatch.log" ]] && grep -q "held (3): the chain is stopped: 3 failures since ARCHIVE_REARM_AT" "$A/summary.md" &&
  ok "OF-2 hold 3: 3 failures after ARCHIVE_REARM_AT (a block, a failure, a cancelled batch; a second exit 75 is the continue job failing) → no request" || no "OF-2 3 failures: $(cat "$A/summary.md")"
mkfx "$T/fxr4" ARCHIVE_REARM_AT="$(iso $(( now - 4 * 3600 )))"
ACFX=$T/fxr4/research/historical/ci ac env AC_STATUS=206
[[ $(wc -l < "$A/curl.calls" 2>/dev/null) == 1 && $(wc -l < "$GD/dispatch.log" 2>/dev/null) == 1 ]] &&
  ok "OF-2 hold 3: the same 3 failures before a later ARCHIVE_REARM_AT → a request (and a dispatch)" || no "OF-2 re-armed: $(cat "$A/summary.md")"
{ dsrun 311 "data-scan scan source=archive" failure 500 420 "scan (2026-07-22)=failure,continue=failure"
  dsrun 314 "data-scan scan source=archive" success 410 390 "Archive guard=success,scan (2026-07-22)=success,Store this day=success"
  dsrun 312 "data-scan scan source=archive" failure 380 360 "scan (2026-07-23)=failure,continue=failure"
  dsrun 313 "data-scan scan source=archive" failure 320 300 "scan (2026-07-23)=failure,continue=failure"; } | dsjson
ACFX=$T/fxr8/research/historical/ci ac env AC_STATUS=206
[[ $(wc -l < "$A/curl.calls" 2>/dev/null) == 1 ]] &&
  ok "OF-2 hold 3: a successful batch between the failures resets the count (1 + 2) → a request" || no "OF-2 success between: $(cat "$A/summary.md")"
{ acrun 521 failure 420 notserved; acrun 522 failure 360 notserved; acrun 523 failure 300 notserved; } | acjson; rm -f "$GD/ds.json"
ACFX=$T/fxr8/research/historical/ci ac env AC_STATUS=206
[[ ! -e "$A/curl.calls" ]] && grep -q "held (3)" "$A/summary.md" &&
  ok "OF-2 hold 3: 3 non-served checks after ARCHIVE_REARM_AT → no request" || no "OF-2 3 checks: $(cat "$A/summary.md")"
gdreset
for v in GD_STORE_FAIL GD_STOP GD_PUBLIC; do
  ac env AC_STATUS=206 "$v=1"
  [[ ! -e "$A/curl.calls" && ! -e "$GD/dispatch.log" ]] && grep -q "held (3):" "$A/summary.md" || bad+=" $v"
done
ac env AC_STATUS=206 DATA_STORE_TOKEN=
[[ ! -e "$A/curl.calls" ]] && grep -q "held (3): the private store cannot be read" "$A/summary.md" || bad+=" no-token"
ac env AC_STATUS=206 DATA_REPO=o/r
[[ ! -e "$A/curl.calls" ]] && grep -q "held (3): DATA_REPO is this repository" "$A/summary.md" || bad+=" this-repo"
[[ -z "$bad" ]] && ok "OF-2 hold 3: zeroed-data unreadable, the storage-stop marker present, a public store, no store token, or this repository as the store → no request" || no "OF-2 store holds:$bad"
bad=""
# 5: the dispatch marker. Two checks back to back: the second sees the first's marker
# (its data-scan run not listed yet) and sends nothing.
ac env AC_STATUS=206; KEEPCACHE=1 ac env AC_STATUS=206
[[ ! -e "$A/curl.calls" && ! -e "$GD/dispatch.log" ]] && grep -q "held (5): dispatch marker archive-dispatch-[0-9T]*Z-900 is 0 min old and its data-scan run is not listed yet" "$A/summary.md" &&
  ok "OF-2 hold 5: two checks back to back → one dispatch (the second holds on the first's marker)" || no "OF-2 back to back: $(cat "$A/summary.md")"
mk() { python3 -c 'import json,sys; print(json.dumps({"actions_caches": [{"key": k, "ref": r} for k, r in (a.split("@") for a in sys.argv[1:])]}))' "$@" > "$GD/caches.json"; }
mkey() { echo "archive-dispatch-$(date -u -d "@$(( $(date -u +%s) - $1 * 60 ))" +%Y%m%dT%H%M%SZ)-$2"; }
mk "$(mkey 14 900)@refs/heads/main"; KEEPCACHE=1 ac env AC_STATUS=206
[[ ! -e "$A/curl.calls" ]] && grep -q "held (5): dispatch marker .* is 14 min old" "$A/summary.md" || bad+=" [14]"
mk "$(mkey 16 900)@refs/heads/main"; KEEPCACHE=1 ac env AC_STATUS=206
[[ $(wc -l < "$A/curl.calls" 2>/dev/null) == 1 ]] || bad+=" [16]"
[[ -z "$bad" ]] && ok "OF-2 hold 5: a marker 14 min old whose run is not listed → no request; 16 min old → the check proceeds" || no "OF-2 marker TTL:$bad"
bad=""
mk "$(mkey 2 900)@refs/heads/main"; acruns "completed|data-scan scan source=archive"
python3 - "$GD/ds.json" <<'PY'
import json, sys, datetime
p = sys.argv[1]; r = json.load(open(p))
t = (datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(minutes=1)).strftime("%Y-%m-%dT%H:%M:%SZ")
r.append({"databaseId": 120, "status": "queued", "conclusion": None, "createdAt": t, "updatedAt": t, "displayTitle": "data-scan scan source=archive"})
json.dump(r, open(p, "w"))
PY
KEEPCACHE=1 ac env AC_STATUS=206
[[ ! -e "$A/curl.calls" ]] && grep -q "held (5): 1 data-scan run(s) that may read the archive" "$A/summary.md" &&
  ok "OF-2 hold 5: once the marker's run is listed, the lane hold takes over (still no request while it is queued)" || no "OF-2 marker listed: $(cat "$A/summary.md")"
acruns
mk "$(mkey 2 900)@refs/heads/other"; KEEPCACHE=1 ac env AC_STATUS=206
[[ $(wc -l < "$A/curl.calls" 2>/dev/null) == 1 ]] || bad+=" [other-ref]"
mk "$(mkey 2 777)@refs/heads/main"; KEEPCACHE=1 ac env AC_STATUS=206
[[ $(wc -l < "$A/curl.calls" 2>/dev/null) == 1 ]] || bad+=" [not-an-archive-check-run]"
mk "archive-dispatch-forged-900@refs/heads/main"; KEEPCACHE=1 ac env AC_STATUS=206
[[ $(wc -l < "$A/curl.calls" 2>/dev/null) == 1 ]] || bad+=" [malformed]"
grep -q 'actions/caches?key=archive-dispatch-&ref=refs/heads/main&per_page=100' "$GD/gh.log" || bad+=" [list-by-ref]"
[[ -z "$bad" ]] && ok "OF-2 hold 5: a marker on another ref, or whose run id is not an archive-check run on the default branch, or malformed → ignored" || no "OF-2 marker validity:$bad"
rm -f "$GD/caches.json"
ac env AC_STATUS=206 GD_CACHE_FAIL=1
[[ ! -e "$A/curl.calls" ]] && grep -qE "held \((2|5)\): .* cannot be (listed|read)" "$A/summary.md" &&
  ok "OF-2 hold 5: an unreadable cache list → no request" || no "OF-2 cache unreadable"
# 6: 60 min since the last archive-lane run ended.
dsrun 331 "data-scan scan source=archive" success 200 59 | dsjson
ac env AC_STATUS=206
[[ ! -e "$A/curl.calls" ]] && grep -q "held (6)" "$A/summary.md" || bad+=" [59]"
dsrun 332 "data-scan scan source=helius" success 200 10 | dsjson
ac env AC_STATUS=206
[[ $(wc -l < "$A/curl.calls" 2>/dev/null) == 1 ]] || bad+=" [helius-10]"
dsrun 333 "data-scan scan source=archive" success 200 61 | dsjson
ac env AC_STATUS=206
[[ $(wc -l < "$A/curl.calls" 2>/dev/null) == 1 ]] || bad+=" [61]"
[[ -z "$bad" ]] && ok "OF-2 hold 6: an archive-lane run that ended 59 min ago → no request; 61 min ago, or a Helius run 10 min ago → a request" || no "OF-2 60 min pause:$bad"
bad=""; rm -f "$GD/ds.json"
# 7: the queue reads the private store and fails closed; a day without a retention value
# is never dispatched.
echo 2026-07-22 > "$GD/published"
mkfx "$T/fxnoret" ARCHIVE_RETENTION=
ACFX=$T/fxnoret/research/historical/ci ac env AC_STATUS=206
[[ ! -e "$A/curl.calls" && ! -e "$GD/dispatch.log" ]] && grep -q "held (7): 2026-07-23 has no retention value" "$A/summary.md" || bad+=" [07-23-unset]"
printf '2026-07-22\n2026-07-23\n' > "$GD/published"
ac env AC_STATUS=206
[[ ! -e "$A/curl.calls" && ! -e "$GD/dispatch.log" ]] && grep -q "held (7): 2026-07-24 has no retention value" "$A/summary.md" || bad+=" [07-24-K2]"
[[ -z "$bad" ]] && ok "OF-2 hold 7: after 07-22 with ARCHIVE_RETENTION unset, and after both measurement days with K2 (no retention record), nothing is sent" || no "OF-2 retention holds:$bad"
bad=""; rm -f "$GD/published"
# --dispatch checks the day again.
for d in 2026-09-25 2026-07-21 2026-09-21 2026-07-24; do
  rc=0; GD="$GD" GH_BIN="$GD/bin/gh" GH_REPO=o/r REF=main GITHUB_STEP_SUMMARY="$A/summary.md" bash "$FX/archive-check.sh" --dispatch "$d" > "$A/out.txt" 2>&1 || rc=$?
  [[ $rc == 1 && ! -e "$GD/dispatch.log" ]] || bad+=" $d:$rc"
done
[[ -z "$bad" ]] && ok "OF-2: archive-check --dispatch refuses 09-25 (holdout), 07-21 (before the list), 09-21 (Helius) and 07-24 (no retention under K2)" || no "OF-2 dispatch refusals:$bad"
bad=""

# A real curl against a local server: one that ignores the range and streams a chunked
# 200 forever, one that answers 206 with 64 bytes. The stream is cut at 65 bytes within
# seconds and nothing is dispatched; the honest 206 dispatches.
cat > "$A/srv.py" <<'PY'
import http.server, sys, time
class H(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    def do_GET(self):
        if self.path == "/stream":
            self.send_response(200); self.send_header("Transfer-Encoding", "chunked"); self.end_headers()
            try:
                while True:
                    self.wfile.write(b"4000\r\n" + b"x" * 0x4000 + b"\r\n"); self.wfile.flush(); time.sleep(0.01)
            except (BrokenPipeError, ConnectionResetError):
                return
        self.send_response(206); self.send_header("Content-Length", "64"); self.send_header("cf-ray", "ok-1"); self.end_headers()
        self.wfile.write(b"y" * 64)
    def log_message(self, *a): pass
s = http.server.ThreadingHTTPServer(("127.0.0.1", 0), H)
print(s.server_port, flush=True); s.serve_forever()
PY
python3 "$A/srv.py" > "$A/port" & srv=$!
for _ in $(seq 50); do [[ -s "$A/port" ]] && break; sleep 0.1; done
port=$(cat "$A/port"); gdreset
t0=$(date +%s)
ac env -u CURL_BIN CURL_BIN=curl NO_PROXY=127.0.0.1 no_proxy=127.0.0.1 ARCHIVE_CHECK_URL="http://127.0.0.1:$port/stream"
t1=$(date +%s)
row=$(grep "^| 20" "$A/summary.md" | tail -1); IFS='|' read -r _ _ st by ex _ <<< "$row"
[[ ! -e "$GD/dispatch.log" ]] && (( t1 - t0 < 10 )) && (( ${st// /} == 200 && ${by// /} <= 65 && ${ex// /} != 0 )) &&
  ok "archive-check: a server ignoring the range and streaming a chunked 200 is cut (${by// /} bytes, curl exit ${ex// /}) in $((t1 - t0)) s, nothing dispatched" || no "archive-check streaming: $row"
ac env -u CURL_BIN CURL_BIN=curl NO_PROXY=127.0.0.1 no_proxy=127.0.0.1 ARCHIVE_CHECK_URL="http://127.0.0.1:$port/ok"
[[ $(wc -l < "$GD/dispatch.log" 2>/dev/null) == 1 ]] && grep -q "| 206 | 64 | 0 | ok-1 |" "$A/summary.md" &&
  ok "archive-check: a real 206 of 64 bytes dispatches once" || no "archive-check real 206: $(cat "$A/summary.md")"
kill $srv 2>/dev/null; wait $srv 2>/dev/null

python3 - "$here/../../../.github/workflows/archive-check.yml" <<'PY' && ok "archive-check workflow: every 3 hours plus dispatch; the holds step, then 'Archive probe (a failure unless served)' only when ready, a Retry-After saved as archive-backoff-<end> on its failure, and on served the marker save before the dispatch step; the back-off annotation in its own step right after the probe (round 4, ruling 25); tokens only in the holds and dispatch steps, the probe step without any; no inputs in the shell, credentials not persisted" || no "archive-check workflow structure"
import sys, yaml
wf = yaml.safe_load(open(sys.argv[1]))
on = wf[True]
assert set(on) == {"schedule", "workflow_dispatch"} and on["schedule"] == [{"cron": "41 */3 * * *"}], on
assert wf["permissions"] == {"contents": "read", "actions": "write"}, wf["permissions"]
steps = wf["jobs"]["check"]["steps"]
assert len(steps) == 7 and steps[0]["with"]["persist-credentials"] is False, steps
chk, probe, ann, ra, save, disp = steps[1:]
# OF-2 round 4, ruling 25: the annotation in its own step right after the probe, on any end but success or skip
assert ann["name"] == "Record the back-off annotation" and ann["if"] == "always() && steps.probe.outcome != 'success' && steps.probe.outcome != 'skipped'", ann
assert ann["env"] == {"END": "${{ steps.probe.outputs.backoff_annotation }}"} and ann["run"].strip() == 'if [[ "$END" =~ ^([0-9]{9,11}|hold)$ ]]; then echo "::warning title=archive-backoff::end=$END"; fi', ann
assert chk["id"] == "check" and chk["run"].endswith('/usr/bin/bash --noprofile --norc "$GITHUB_WORKSPACE/research/historical/ci/archive-check.sh"') and "github.token" in chk["env"]["GH_TOKEN"], chk
assert chk["env"]["DATA_REPO"] == "${{ vars.DATA_REPO }}" and chk["env"]["DATA_STORE_TOKEN"] == "${{ secrets.DATA_STORE_TOKEN }}", chk["env"]
assert probe["name"] == "Archive probe (a failure unless served)" and probe["id"] == "probe" and probe["if"] == "steps.check.outputs.ready == 'true'", probe
assert probe["run"] == 'research/historical/ci/archive-check.sh --probe "$DAY"' and probe["env"]["DAY"] == "${{ steps.check.outputs.day }}", probe
assert "GH_TOKEN" not in probe["env"] and "DATA_STORE_TOKEN" not in probe["env"], probe
assert ra["uses"].startswith("actions/cache/save@") and ra["if"] == "failure() && steps.probe.outputs.backoff_end != ''", ra
assert ra["with"] == {"path": "${{ runner.temp }}/archive-backoff", "key": "archive-backoff-${{ steps.probe.outputs.backoff_end }}-${{ github.run_id }}"}, ra
assert save["uses"].startswith("actions/cache/save@") and save["if"] == "steps.probe.outputs.served == 'true'", save
assert save["with"] == {"path": "${{ runner.temp }}/archive-dispatch", "key": "${{ steps.probe.outputs.marker }}"}, save
assert disp["if"] == "steps.probe.outputs.served == 'true'" and disp["run"] == 'research/historical/ci/archive-check.sh --dispatch "$DAY"', disp
assert disp["env"]["DAY"] == "${{ steps.check.outputs.day }}" and "DATA_STORE_TOKEN" not in disp["env"], disp
assert [s.get("name") for s in steps if "secrets." in str(s) or "github.token" in str(s)] == ["Holds", "Dispatch the day"]
assert all("${{" not in st.get("run", "") for st in steps)
assert not any(k in str(steps) for k in ("ARCHIVE_CHECK_URL", "CURL_BIN", "GH_BIN", "ARCHIVE_GO", "AG_NOW", "ARCHIVE_GUARD_DIR")), "test-only overrides in the workflow"
assert set(on["workflow_dispatch"]["inputs"]) == {"helius_runs"} and on["workflow_dispatch"]["inputs"]["helius_runs"]["default"] == "", on
assert chk["env"]["HELIUS_RUNS"] == "${{ github.event_name == 'workflow_dispatch' && inputs.helius_runs || '' }}", chk["env"]
PY

python3 - "$here/../../../.github/workflows/data-scan.yml" <<'PY' && ok "data-scan source helius: refused without a cap of 1 to 1000000 or outside scan mode; the key only in the scan and QA steps and only for helius; own progress cache; the chain carries source and cap" || no "data-scan helius wiring"
import sys, yaml
wf = yaml.safe_load(open(sys.argv[1]))
ins = wf[True]["workflow_dispatch"]["inputs"]
assert ins["source"]["options"] == ["archive", "helius"] and ins["source"]["default"] == "archive", ins["source"]
plan = next(st for st in wf["jobs"]["plan"]["steps"] if st.get("id") == "days")["run"]
assert 'source helius needs max_credits from 1 to 1000000' in plan and 'source helius is for mode scan only' in plan
steps = wf["jobs"]["scan"]["steps"]
key = [s for s in steps if "HELIUS_API_KEY" in str(s)]
assert [s.get("id") for s in key] == ["scan", "qa"], [s.get("name") for s in key]
for s in key:
    assert s["env"]["HELIUS_API_KEY"] == "${{ inputs.source == 'helius' && secrets.HELIUS_API_KEY || '' }}", s["env"]
assert "rpc-day.sh" in steps[[s.get("id") for s in steps].index("scan")]["run"]
caches = [s for s in steps if "actions/cache" in s.get("uses", "") and s["with"]["path"] == "${{ runner.temp }}/work/sealed"]
saves = [s for s in caches if "cache/save" in s["uses"]]
assert saves and all(s["with"]["key"].startswith("${{ inputs.source == 'helius' && 'data-rpc' || 'data-scan' }}-") for s in saves), saves
res = next(s for s in caches if "cache/restore" in s["uses"])
assert res["with"]["key"] == "${{ steps.pickprogress.outputs.key || format('{0}-{1}-k{2}-{3}-fresh', inputs.source == 'helius' && 'data-rpc' || 'data-scan', matrix.day, steps.cachekid.outputs.kid, github.run_id) }}" and "restore-keys" not in res["with"], res
pick = next(s for s in steps if s.get("id") == "pickprogress")
assert pick["env"]["PREFIX"] == "${{ inputs.source == 'helius' && 'data-rpc' || 'data-scan' }}-${{ matrix.day }}-", pick
r = wf["jobs"]["continue"]["steps"][-1]["run"]
assert '-f source="$SOURCE" -f max_credits="$MAX_CREDITS" -f rpc_rps="$RPC_RPS"' in r, r
assert 'rpc_rps must be from 1 to 50' in plan and ins["rpc_rps"]["default"] == "5"
for s in key:
    assert s["env"]["RPC_RPS"] == "${{ inputs.rpc_rps }}", s["env"]
assert "secrets." not in str(wf["jobs"]["continue"])
# OF-2: the plan job's only secret is the store token, in its clean "Archive guard" step
psec = [st for st in wf["jobs"]["plan"]["steps"] if "secrets." in str(st)]
assert [st["name"] for st in psec] == ["Archive guard"] and str(psec[0]).count("secrets.") == 1 and psec[0]["env"]["DATA_STORE_TOKEN"] == "${{ secrets.DATA_STORE_TOKEN }}", psec
assert psec[0]["run"].startswith("/usr/bin/env -i PATH=/usr/bin:/bin "), psec
saq = next(s for s in steps if s.get("name") == "Save progress after QA")
assert "inputs.source == 'helius'" in saq["if"] and "always()" in saq["if"], saq["if"]
PY

python3 - "$here/../../../.github/workflows/data-scan.yml" <<'PY' && ok "data-scan run-name carries mode and source (archive-check reads it): data-scan scan source=helius / source=archive" || no "data-scan run-name"
import sys, yaml
wf = yaml.safe_load(open(sys.argv[1]))
assert wf["run-name"] == "data-scan ${{ inputs.mode }} source=${{ inputs.source || 'archive' }}", wf.get("run-name")
assert wf[True]["workflow_dispatch"]["inputs"]["source"]["default"] == "archive"
PY
python3 - "$here/../../../.github/workflows/data-scan.yml" <<'PY' && ok "ARCHIVE-NODUP: a Helius dispatch of a day already published from the archive is skipped: the published check runs for both sources and gates every read" || no "data-scan helius skips published day"
import sys, yaml
steps = yaml.safe_load(open(sys.argv[1]))["jobs"]["scan"]["steps"]
pub = next(s for s in steps if s.get("id") == "published")
assert "if" not in pub and "inputs.source" not in str(pub) and "publish-day.sh\" --check" in pub["run"], pub
scan = next(s for s in steps if s.get("id") == "scan")
assert scan["if"] == "steps.published.outputs.complete != 'true'" and "rpc-day.sh" in scan["run"], scan
qa = next(s for s in steps if s.get("id") == "qa")
assert "steps.published.outputs.complete != 'true'" in qa["if"], qa
PY
# ---- HISTORY-RESUME: transient RPC errors resume; progress never moves backwards ----
o="$T/rdtr"; rm -rf "$o"; rc=0; rd "$o" RPC_CREDITS=5 RPC_RC=1 RPC_ERR="2026/10/05 17:52:00 unit 1039 449172000-449176499: rpc response: unexpected end of JSON input" || rc=$?
msg=0; grep -q "truncated or unparsable RPC response (transient)" "$T/summary.md" && grep -q "unexpected end of JSON input" "$T/out.txt" && msg=1
rc2=0; o2="$T/rdtr2"; rm -rf "$o2"; rd "$o2" RPC_CREDITS=5 RPC_RC=1 RPC_ERR="unit x: decode failed: bad block" || rc2=$?
rc3=0; o3="$T/rdtr3"; rm -rf "$o3"; rd "$o3" RPC_CREDITS=5 RPC_RC=3 RPC_ERR="unit x: rpc response: unexpected EOF" || rc3=$?
[[ $rc == 75 && $rc2 == 1 && $rc3 == 3 && $msg == 1 && $(cat "$o/rpc-credits-used") == 5 ]] &&
  ok "HISTORY-RESUME: rpc-day turns a truncated RPC response (rpcscan exit 1, 'rpc response: unexpected end of JSON input') into exit 75 with credits booked; other exit-1 errors stay fatal, and another exit code with the same text passes through" || no "rpc-day transient: rc=$rc rc2=$rc2"
PP="$T/pp"; rm -rf "$PP"; mkdir -p "$PP/bin"
cat > "$PP/bin/gh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
[[ "$1" == api ]] || exit 2
shift; url="" jqx=""
while (( $# )); do case "$1" in --jq) jqx=$2; shift ;; repos/*) url=$1 ;; esac; shift; done
echo "$url" >> "$PPD/calls.log"
[[ -n "${PP_FAIL:-}" ]] && { echo "HTTP 502" >&2; exit 1; }
jq -r "$jqx" "$PPD/caches.json"
EOF
chmod +x "$PP/bin/gh"
pp() { : > "$PP/out"; KID=${PKID-0123456789ab} PPD="$PP" GH_BIN="$PP/bin/gh" GITHUB_REPOSITORY=o/r GITHUB_REF=refs/heads/ccr-x GITHUB_OUTPUT="$PP/out" GITHUB_STEP_SUMMARY="$PP/sum" bash "$here/progress-pick.sh" "$@"; }
python3 - "$PP/caches.json" <<'PY'
import json, sys
c = lambda k, s, t, r="refs/heads/ccr-x": {"key": k, "size_in_bytes": s, "created_at": t, "ref": r}
json.dump({"actions_caches": [
  c("data-rpc-2026-09-21-k0123456789ab-37264343113-1", 4186871358, "2026-10-05T09:30:56Z"),
  c("data-rpc-2026-09-21-k0123456789ab-37290557627-1", 4186871400, "2026-10-05T09:47:50Z"),
  c("data-rpc-2026-09-21-k0123456789ab-37292410621-1", 1024, "2026-10-05T09:49:26Z"),
  c("data-rpc-2026-09-21-k0123456789ab-37312693149-1", 810661685, "2026-10-05T17:52:50Z"),
  c("data-rpc-2026-09-21-k0123456789ab-37290557627-1-qa", 4186871300, "2026-10-05T10:00:00Z"),
  c("data-rpc-2026-09-21-k0123456789ab-37312693149-1-qa", 810661600, "2026-10-05T18:00:00Z"),
  c("data-rpc-2026-09-21-k0123456789ab-1-1", 9900000000, "2026-10-05T10:00:00Z", "refs/pull/7/merge"),
  c("data-rpc-2026-09-210-1-1", 9900000000, "2026-10-05T10:00:00Z")]}, open(sys.argv[1], "w"))
PY
pp data-rpc-2026-09-21- >/dev/null && grep -qx "key=data-rpc-2026-09-21-k0123456789ab-37290557627-1-qa" "$PP/out" &&
  ok "HISTORY-RESUME: progress-pick resumes from the largest run's progress (66 units), never the newest near-empty or 11-unit one; within a run its -qa save wins although a few bytes smaller (booked QA credits); other refs and other days are ignored" || no "progress-pick: $(cat "$PP/out")"
python3 - "$PP/caches.json" <<'PY'
import json, sys
c = lambda k, s, t: {"key": k, "size_in_bytes": s, "created_at": t, "ref": "refs/heads/ccr-x"}
json.dump({"actions_caches": [c("data-rpc-2026-09-21-k0123456789ab-100-1", 4000000000, "2026-10-05T01:00:00Z"), c("data-rpc-2026-09-21-k0123456789ab-100-1-qa", 4100000000, "2026-10-05T03:00:00Z")]}, open(sys.argv[1], "w"))
PY
pp data-rpc-2026-09-21- >/dev/null && grep -qx "key=data-rpc-2026-09-21-k0123456789ab-100-1-qa" "$PP/out" &&
  ok "HISTORY-RESUME: progress-pick takes a run's larger, newer -qa save over its base (the reviewer's case)" || no "progress-pick qa larger: $(cat "$PP/out")"
python3 - "$PP/caches.json" <<'PY'
import json, sys
c = lambda k, s, t: {"key": k, "size_in_bytes": s, "created_at": t, "ref": "refs/heads/ccr-x"}
json.dump({"actions_caches": [c("data-rpc-2026-09-21-k0123456789ab-200-1", 4000000000, "2026-10-05T01:00:00Z"), c("data-rpc-2026-09-21-k0123456789ab-300-1", 3900000000, "2026-10-05T05:00:00Z")]}, open(sys.argv[1], "w"))
PY
pp data-rpc-2026-09-21- >/dev/null && grep -qx "key=data-rpc-2026-09-21-k0123456789ab-200-1" "$PP/out" &&
  ok "HISTORY-RESUME: progress-pick keeps an older run whose progress is clearly larger (2.5 %, more units) over a newer smaller one" || no "progress-pick older larger: $(cat "$PP/out")"
echo '{"actions_caches": []}' > "$PP/caches.json"; pp data-rpc-2026-09-21- >/dev/null && grep -qx "key=" "$PP/out" && ok "HISTORY-RESUME: progress-pick with no saved progress picks nothing" || no "progress-pick empty"
bad=""; rc=0; PP_FAIL=1 pp data-rpc-2026-09-21- >/dev/null 2>&1 || rc=$?; [[ $rc != 0 ]] || bad+=" api"
rc=0; pp 'data-rpc-2026-09-21' >/dev/null 2>&1 || rc=$?; [[ $rc == 2 ]] || bad+=" prefix"
rc=0; PKID= pp data-rpc-2026-09-21- >/dev/null 2>&1 || rc=$?; [[ $rc == 2 ]] || bad+=" no-kid"
[[ -z "$bad" ]] && ok "HISTORY-RESUME: progress-pick fails on an API error (nothing is read), on a bad prefix and without a cache key id" || no "progress-pick failures:$bad"
# OF-2 round 6, ruling 44a: a progress of the day sealed with another key, or not sealed, refuses.
bad=""
for k in data-scan-2026-07-22-kfedcba987654-5-1 data-scan-2026-07-22-5-1; do
  printf '{"actions_caches": [{"key": "data-scan-2026-07-22-k0123456789ab-4-1", "size_in_bytes": 9, "created_at": "2026-10-05T01:00:00Z", "ref": "refs/heads/ccr-x"}, {"key": "%s", "size_in_bytes": 1, "created_at": "2026-10-05T02:00:00Z", "ref": "refs/heads/ccr-x"}]}' "$k" > "$PP/caches.json"
  rc=0; pp data-scan-2026-07-22- >/dev/null 2>&1 || rc=$?; [[ $rc == 2 ]] && ! grep -q "^key=" "$PP/out" && grep -q "sealed with another key or not sealed" "$PP/sum" || bad+=" [$k]:$rc"
done
printf '{"actions_caches": [{"key": "data-scan-2026-07-22-k0123456789ab-4-1", "size_in_bytes": 9, "created_at": "2026-10-05T01:00:00Z", "ref": "refs/heads/ccr-x"}]}' > "$PP/caches.json"
pp data-scan-2026-07-22- >/dev/null && grep -qx "key=data-scan-2026-07-22-k0123456789ab-4-1" "$PP/out" || bad+=" own"
[[ -z "$bad" ]] && ok "OF-2 r6 ruling 44a: progress-pick refuses (no key, nothing read) when the day has a progress sealed with another key id or saved unsealed, and picks one sealed with this run's key id" || no "OF-2 r6 pick key id:$bad"
PG="$T/pg"; rm -rf "$PG"; mkdir -p "$PG/rt" "$PG/d/units/1039/a" "$PG/d/units/1039/b" "$PG/d/units/1039/c"; for u in a b c; do echo '{}' > "$PG/d/units/1039/$u/stats.json"; done
pg() { : > "$PG/out"; RUNNER_TEMP="$PG/rt" GITHUB_OUTPUT="$PG/out" GITHUB_STEP_SUMMARY="$PG/sum" bash "$here/progress-guard.sh" "$@" "$PG/d" >/dev/null; }
bad=""
pg check; grep -q ok=true "$PG/out" && bad+=" no-record"
pg record; [[ $(cat "$PG/rt/progress-restored") == 3 ]] || bad+=" record"
pg check; grep -qx ok=true "$PG/out" || bad+=" same"
mkdir -p "$PG/d/units/1039/d"; echo '{}' > "$PG/d/units/1039/d/stats.json"; pg check; grep -qx ok=true "$PG/out" || bad+=" more"
rm -rf "$PG/d/units/1039/a" "$PG/d/units/1039/b"; pg check; grep -q ok=true "$PG/out" && bad+=" fewer"
[[ -z "$bad" ]] && ok "HISTORY-RESUME: progress-guard allows a save only after a finished restore and with at least as many finished units as were restored" || no "progress-guard:$bad"
bad=""
for u in a b c; do mkdir -p "$PG/d/units/1039/$u"; echo '{}' > "$PG/d/units/1039/$u/stats.json"; done; rm -rf "$PG/d/units/1039/d"
rc=0; : > "$PG/sum"; EXPECT_UNITS=4 PICKED=data-rpc-2026-09-21-9-1 pg record || rc=$?
[[ $rc == 1 ]] && grep -q "data-rpc-2026-09-21-9-1 holds 3 finished units, fewer than expect_units 4: stopping before any read" "$PG/sum" || bad+=" below:$rc"
rc=0; EXPECT_UNITS=3 PICKED=k pg record || rc=$?; [[ $rc == 0 ]] || bad+=" equal:$rc"
rc=0; EXPECT_UNITS= pg record || rc=$?; [[ $rc == 0 ]] || bad+=" empty:$rc"
rc=0; EXPECT_UNITS=6x pg record || rc=$?; [[ $rc == 2 ]] || bad+=" bad:$rc"
[[ -z "$bad" ]] && ok "HISTORY-RESUME: expect_units stops the job before any read when the picked progress holds fewer units (naming the entry); equal or unset passes; a non-number is refused" || no "progress-guard expect_units:$bad"
python3 - "$here/../../../.github/workflows/data-scan.yml" <<'PY' && ok "HISTORY-RESUME: data-scan resumes from the picked entry, records it, and saves progress (both saves) only when the restore finished and the progress did not shrink; the scan job gains actions: read only" || no "data-scan progress wiring"
import sys, yaml
wf = yaml.safe_load(open(sys.argv[1]))
job = wf["jobs"]["scan"]
assert job["permissions"] == {"contents": "read", "actions": "read"}, job["permissions"]
steps = job["steps"]
ids = [s.get("id") or s.get("name") for s in steps]
assert ids.index("pickprogress") < ids.index("restore") < ids.index("record") < ids.index("scan")
rec = steps[ids.index("record")]
assert rec["run"] == 'research/historical/ci/progress-guard.sh record "$RUNNER_TEMP/work/data"', rec
assert rec["env"] == {"EXPECT_UNITS": "${{ inputs.expect_units }}", "PICKED": "${{ steps.pickprogress.outputs.key }}"} and rec["id"] == "record", rec
assert wf[True]["workflow_dispatch"]["inputs"]["expect_units"]["default"] == "", "expect_units defaults to no check"
cont = wf["jobs"]["continue"]
assert '-f expect_units="$EXPECT_UNITS"' in cont["steps"][-1]["run"] and cont["steps"][-1]["env"]["EXPECT_UNITS"] == "${{ inputs.expect_units }}", "the chain carries expect_units"
for guard, save in (("shrink", "save"), ("shrinkqa", "Save progress after QA")):
    g, s = steps[ids.index(guard)], steps[ids.index(save)]
    assert "steps.restore.outcome == 'success'" in g["if"] and "steps.record.outcome == 'success'" in g["if"] and "always()" in g["if"] and 'progress-guard.sh check "$RUNNER_TEMP/work/data"' in g["run"], g
    assert f"steps.{guard}.outputs.ok == 'true'" in s["if"] and ids.index(guard) < ids.index(save), s
PY
# ---- DATA-PUB: a day read over RPC (source helius) is never published or uploaded ----
python3 - "$here/../../../.github/workflows/data-scan.yml" <<'PY' && ok "data-scan source helius: no day artifact, no data-day or data-volume publish; the packaged assets go only to the actions cache (data-rpc-assets-DAY-*)" || no "data-scan helius publish gate"
import sys, yaml
steps = yaml.safe_load(open(sys.argv[1]))["jobs"]["scan"]["steps"]
for s in steps:
    run, uses, cond = s.get("run", ""), s.get("uses", ""), s.get("if", "")
    if s.get("id") == "pickprogress" and run.endswith('research/historical/ci/progress-pick.sh" "$PREFIX"'):
        continue  # reads the cache list only (actions: read)
    outward = ("upload-artifact" in uses and s["with"]["name"] != "resume-${{ matrix.day }}") or ("github.token" in str(s) and "--check" not in run)
    if outward:
        assert "inputs.source != 'helius'" in cond, (s.get("name") or uses, cond)
pub = [s for s in steps if 'publish-day.sh" "$DAY"' in s.get("run", "") or "publish-volume.sh" in s.get("run", "")]
assert len(pub) == 2 and all("inputs.source != 'helius'" in s["if"] for s in pub), pub
keep = [s for s in steps if "actions/cache/save" in s.get("uses", "") and s["with"]["path"] == "${{ runner.temp }}/work/sealed-assets"]
assert len(keep) == 1 and keep[0]["with"]["key"].startswith("data-rpc-assets-${{ matrix.day }}-"), keep
assert "inputs.source == 'helius'" in keep[0]["if"] and "steps.published.outputs.complete != 'true'" in keep[0]["if"], keep[0]["if"]
names = [s.get("name") for s in steps]
assert names.index(keep[0]["name"]) > names.index("Package the day")
PY
export GH_BIN="$T/bin/gh"
rp="$T/rpcpub"; rm -rf "$rp"; mkdir -p "$rp"; d=2026-09-28
for f in units-$d.tar.part00 events-$d.tar qa-$d.md qa-$d.json parity-$d.json; do echo "$f" > "$rp/$f"; done
printf '{\n  "units": [\n    {\n      "root_cid": "rpc:getBlock"\n    }\n  ]\n}\n' > "$rp/manifest-$d.json"
(cd "$rp" && sha256sum units-* events-* qa-* manifest-* parity-* > SHA256SUMS-$d)
rm -rf "$T/rel/data-day-$d"; : > "$T/created.log"
out=$(bash "$here/publish-day.sh" $d "$rp" 2>&1) && no "publish-day published a day read over RPC" ||
  { [[ "$out" == *"read over RPC"* && ! -e "$T/rel/data-day-$d" && ! -s "$T/created.log" ]] && ok "publish-day: a day whose manifest lists an RPC unit (root_cid rpc:getBlock) is refused before any gh call" || no "publish-day rpc: $out"; }
sp="$T/strictpub"; rm -rf "$sp"; cp -r "$rp" "$sp"; d2=2026-09-27
(cd "$sp" && for f in *; do mv "$f" "${f//$d/$d2}"; done && echo '{"units": []}' > manifest-$d2.json && sha256sum units-* events-* qa-* manifest-* parity-* > SHA256SUMS-$d2 &&
  sed -i "s/^\(.\{20\}\)[0-9a-f]*\(  qa-$d2.md\)\$/\1\2/" SHA256SUMS-$d2)
rm -rf "$T/rel/data-day-$d2"; : > "$T/created.log"
out=$(bash "$here/publish-day.sh" $d2 "$sp" 2>&1) && no "publish-day published with a truncated hash line" ||
  { grep -q "^.\{20\}  qa-$d2.md\$" "$sp/SHA256SUMS-$d2" && [[ ! -e "$T/rel/data-day-$d2" && ! -s "$T/created.log" ]] && ok "publish-day: a truncated hash line in SHA256SUMS fails (sha256sum --strict)" || no "publish-day strict: $out"; }
: > "$T/created.log"; rv="$T/rpcvol"; rm -rf "$rv"; mkdir -p "$rv"; vrows > "$rv/volume-hours-2026-09-30.csv"; echo '{"mismatches": [], "problems": []}' > "$rv/volume-check-2026-09-30.json"
cp "$rp/manifest-$d.json" "$rv/manifest-2026-09-30.json"; rm -rf "$T/rel/data-volume-2026-09-30"
out=$(bash "$here/publish-volume.sh" 2026-09-30 "$rv" 2>&1) && no "publish-volume published a day read over RPC" ||
  { [[ "$out" == *"read over RPC"* && ! -e "$T/rel/data-volume-2026-09-30" && ! -s "$T/created.log" ]] && ok "publish-volume: a day whose manifest lists an RPC unit is refused before any gh call" || no "publish-volume rpc: $out"; }
rm -f "$rv/manifest-2026-09-30.json"
bash "$here/publish-volume.sh" 2026-09-30 "$rv" >/dev/null && [[ -e "$T/rel/data-volume-2026-09-30" ]] && ok "publish-volume: the same files without an RPC manifest still publish (control)" || no "publish-volume control"
unset GH_BIN

# The plan job's own validation, run as written in data-scan.yml.
python3 - "$here/../../../.github/workflows/data-scan.yml" > "$T/plan.py" <<'PY'
import sys, yaml
run = next(st for st in yaml.safe_load(open(sys.argv[1]))["jobs"]["plan"]["steps"] if st.get("id") == "days")["run"]
print(run.split("<<'EOF' >> \"$GITHUB_OUTPUT\"\n", 1)[1].rsplit("\nEOF", 1)[0])
PY
( . "$here/archive-limits.conf"
  python3 - "$here/../../../.github/workflows/data-scan.yml" "$ARCHIVE_MAX_MBPS" "$ARCHIVE_MAX_RPS" "$ARCHIVE_PARALLEL" "$ARCHIVE_DL" "$ARCHIVE_BACKOFF_S" "$ARCHIVE_DAYS_PER_CHECK" <<'PY'
import sys, yaml
wf = yaml.safe_load(open(sys.argv[1]))
mbps, rps, par, dl, back, days = map(int, sys.argv[2:])
assert (mbps, rps, par, dl, back, days) == (40, 10, 1, 4, 10800, 1), (mbps, rps, par, dl, back, days)
assert wf[True]["workflow_dispatch"]["inputs"]["max_mbps"]["default"] == str(mbps)
assert f"if not 0 < mbps <= {mbps}:" in next(st for st in wf["jobs"]["plan"]["steps"] if st.get("id") == "days")["run"]
PY
) && ok "ARCHIVE-SAFE: archive-limits.conf holds 40 MB/s, 10 req/s, 1 x 4 connections, 3 h back-off, 1 day per check, and data-scan.yml's max_mbps default and check match it" || no "archive-limits consistency"
plan() { env MODE=scan DAYS=2026-09-21 MAX_MBPS=40 SOURCE=helius MAX_CREDITS=260000 RPC_RPS=5 REGIME_BOUNDARY_DAY=2026-10-02 "$@" python3 "$T/plan.py" > "$T/plan.out" 2>&1; }
bad=""
plan || bad+=" valid-refused"
for v in 0 51 5.5 ""; do plan RPC_RPS="$v" && bad+=" rps=$v"; done
for v in 0 1000001 ""; do plan MAX_CREDITS="$v" && bad+=" credits=$v"; done
plan MODE=volume && bad+=" helius-volume"
plan SOURCE=other && bad+=" source=other"
plan SOURCE=archive MAX_CREDITS=0 RPC_RPS=0 || bad+=" archive-refused"
for v in 41 80 0; do plan SOURCE=archive MAX_MBPS=$v && bad+=" mbps=$v"; done
[[ -z "$bad" ]] && ok "data-scan plan: refuses max_mbps 41, 80 and 0 (ARCHIVE-SAFE), rpc_rps 0, 51, 5.5 and empty, a cap outside 1..1000000, helius outside scan, an unknown source; accepts the free day and archive scans" || no "data-scan plan validation:$bad"

# ---- DATA-KEEP: data-keep.yml and keep-check.sh keep helius assets alive in the cache ----
python3 - "$here/../../../.github/workflows/data-keep.yml" "$here/../../../.github/workflows/data-scan.yml" <<'PY' && ok "data-keep workflow: cron every 3 days plus dispatch, contents and actions read only, no secret, no artifact or release, actions pinned to the repo's SHAs, restores at data-scan's helius save path and fails on a miss" || no "data-keep workflow structure"
import re, sys, yaml
wf, ds = yaml.safe_load(open(sys.argv[1])), yaml.safe_load(open(sys.argv[2]))
text = open(sys.argv[1]).read()
assert set(wf[True]) == {"schedule", "workflow_dispatch"} and wf[True]["schedule"] == [{"cron": "23 4 */3 * *"}], wf[True]
assert wf["permissions"] == {"contents": "read", "actions": "read"}, wf["permissions"]
assert all("permissions" not in j for j in wf["jobs"].values()), "no job widens the permissions"
assert "secrets." not in text and "HELIUS_API_KEY" not in text and "api-key" not in text.lower(), "no secret or Helius key"
steps = [s for j in wf["jobs"].values() for s in j["steps"]]
for s in steps:
    u, r = s.get("uses", ""), s.get("run", "")
    assert "upload-artifact" not in u and "actions/cache/save" not in u and "release" not in r and "gh " not in r, s
    assert not u or re.fullmatch(r"[\w./-]+@[0-9a-f]{40}", u), u
    if "checkout" in u:
        assert s["with"]["persist-credentials"] is False, s
pinned = {s["uses"] for j in ds["jobs"].values() for s in j.get("steps", []) if "uses" in s}
assert {s["uses"] for s in steps if "uses" in s} <= pinned, "actions pinned to SHAs already used by data-scan.yml"
res = {s["if"]: s for s in steps if "actions/cache/restore" in s.get("uses", "")}
assert set(res) == {"matrix.entry.kind == 'assets'", "matrix.entry.kind == 'progress'"}, list(res)
dsave = ds["jobs"]["scan"]["steps"]
asave = [s for s in dsave if "actions/cache/save" in s.get("uses", "") and str(s["with"]["key"]).startswith("data-rpc-assets-")]
psave = [s for s in dsave if s.get("name") == "Save progress"]
assert len(asave) == 1 and res["matrix.entry.kind == 'assets'"]["with"]["path"] == asave[0]["with"]["path"], asave
# OF-2 rounds 6-7, rulings 44a and 51: progress and assets are saved sealed under
# "-k<key id>-" names; data-keep restores only those, at the same sealed paths.
assert asave[0]["with"]["path"] == "${{ runner.temp }}/work/sealed-assets" and "-k${{ steps.cachekid.outputs.kid }}-" in asave[0]["with"]["key"], asave
assert len(psave) == 1 and psave[0]["with"]["path"] == "${{ runner.temp }}/work/sealed" == res["matrix.entry.kind == 'progress'"]["with"]["path"], psave
assert psave[0]["with"]["key"].startswith("${{ inputs.source == 'helius' && 'data-rpc' || 'data-scan' }}-${{ matrix.day }}-k${{ steps.cachekid.outputs.kid }}-${{ github.run_id }}-${{ github.run_attempt }}"), psave
for s in res.values():
    assert s["with"]["fail-on-cache-miss"] is True and s["with"]["key"] == "${{ matrix.entry.key }}", s
chk = {s["if"]: s["run"] for s in wf["jobs"]["keep"]["steps"] if "run" in s and "if" in s}
assert "keep-check.sh verify" in chk["matrix.entry.kind == 'assets'"] and "keep-check.sh progress" in chk["matrix.entry.kind == 'progress'"], chk
keep = wf["jobs"]["keep"]
assert keep["if"] == "needs.list.outputs.count != '0'" and keep["strategy"]["max-parallel"] == 1, keep
runs = [s["run"] for s in keep["steps"] if "run" in s]
assert any("keep-check.sh verify" in r for r in runs) and any("keep-check.sh touched" in r for r in runs), runs
assert all("${{" not in r for r in runs), "inputs reach the shell only through env"
tok = [s for s in steps if "github.token" in str(s)]
assert all("keep-check.sh list" in s["run"] or "keep-check.sh touched" in s["run"] for s in tok), tok
PY
K="$T/keep"; rm -rf "$K"; mkdir -p "$K/bin"
cat > "$K/bin/gh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
[[ "$1" == api ]] || exit 2
shift; url="" jqx=""
while (( $# )); do case "$1" in --jq) jqx=$2; shift ;; repos/*) url=$1 ;; esac; shift; done
echo "$url" >> "$KG/calls.log"
case "$url" in
  repos/o/r) f="$KG/repo.json" ;;
  */actions/cache/usage) f="$KG/usage.json" ;;
  */actions/caches*) f="$KG/caches.json" ;;
  *) exit 2 ;;
esac
jq -r "$jqx" "$f"
EOF
chmod +x "$K/bin/gh"
kc() { KG="$K" GH_BIN="$K/bin/gh" GITHUB_REPOSITORY=o/r GITHUB_STEP_SUMMARY="$K/sum" GITHUB_OUTPUT="$K/out" KEEP_POLL=1 bash "$here/keep-check.sh" "$@"; }
kcache() { python3 - "$K/caches.json" "$@" <<'PY'
import json, sys
out, *rows = sys.argv[1:]
json.dump({"actions_caches": [{"key": r.split(",")[0], "size_in_bytes": int(r.split(",")[1]), "last_accessed_at": r.split(",")[2],
                                "ref": (r.split(",") + ["refs/heads/ccr-x"])[3] or "refs/heads/ccr-x",
                                "created_at": (r.split(",") + ["", "2026-10-01T00:00:00Z"])[4]} for r in rows]}, open(out, "w"))
PY
}
: > "$K/sum"; : > "$K/out"; kcache; echo '{"active_caches_size_in_bytes": 1000}' > "$K/usage.json"; echo '{"default_branch": "ccr-x"}' > "$K/repo.json"
kc list >/dev/null && grep -qx "count=0" "$K/out" && grep -qx "entries=\[\]" "$K/out" && grep -q "0 entries" "$K/sum" &&
  ok "keep-check list: no entry gives count=0 (the keep job is skipped)" || no "keep-check list empty: $(cat "$K/out")"
: > "$K/sum"; : > "$K/out"
KD=k0123456789ab
kcache "data-rpc-assets-2026-09-21-$KD-37185822426-1,4100000000,2026-10-05T01:00:00Z" "data-rpc-scan-2026-09-21-1-1,9,2026-10-05T01:00:00Z" "data-rpc-assets-2026-09-20-$KD-3-1,4000000000,2026-10-06T01:00:00Z" \
  "data-rpc-assets-2026-09-19-$KD-7-1,3000000000,2026-10-06T01:00:00Z,refs/pull/5/merge" "data-rpc-assets-2026-09-18-$KD-8-1,3000000000,2026-10-06T01:00:00Z,refs/heads/other" \
  "data-rpc-assets-2026-09-17-9-1,3000000000,2026-10-06T01:00:00Z"
echo '{"active_caches_size_in_bytes": 8200000000}' > "$K/usage.json"
kc list > "$K/stdout" && grep -qx 'count=2' "$K/out" &&
  grep -qx 'entries=\[{"key":"data-rpc-assets-2026-09-20-'$KD'-3-1","day":"2026-09-20","before":"2026-10-06T01:00:00Z","kind":"assets"},{"key":"data-rpc-assets-2026-09-21-'$KD'-37185822426-1","day":"2026-09-21","before":"2026-10-05T01:00:00Z","kind":"assets"}\]' "$K/out" &&
  grep -q "| \`data-rpc-assets-2026-09-21-$KD-37185822426-1\` | assets | 4.10 GB |" "$K/sum" && grep -q "2 entries, 8.10 GB; all repository caches 8.20 GB of 10 GB" "$K/sum" &&
  grep -q "Warning: repository caches above 7 GB" "$K/sum" && grep -q "::warning::" "$K/stdout" &&
  ! grep -q "2026-09-19\|2026-09-18\|2026-09-17" "$K/out" "$K/sum" &&
  ok "keep-check list: only sealed data-rpc-assets-DAY-k<KID>-* entries of the default branch (a PR-ref, other-branch or unsealed entry is left to expire), with key, day and last access; sizes and total in the summary, a warning above 7 GB" || no "keep-check list: $(cat "$K/out")"
: > "$K/sum"; echo '{"active_caches_size_in_bytes": 7000000000}' > "$K/usage.json"
kc list > "$K/stdout" && ! grep -q "Warning" "$K/sum" && ! grep -q "::warning::" "$K/stdout" && ok "keep-check list: no warning at 7 GB or less" || no "keep-check list no warning"
: > "$K/out"; kcache "data-rpc-assets-bad,1,2026-10-05T01:00:00Z" "data-rpc-2026-09-21-5-1,1,2026-10-05T01:00:00Z"; kc list >/dev/null 2>&1 && grep -qx "count=0" "$K/out" && ok "keep-check list: a malformed or unsealed data-rpc key is never kept (OF-2 ruling 51)" || no "keep-check list kept an unsealed key"
echo '{"active_caches_size_in_bytes": null}' > "$K/usage.json"; kcache; kc list >/dev/null 2>&1 && no "keep-check list accepted unreadable usage" || ok "keep-check list: an unreadable cache usage fails"
echo '{"active_caches_size_in_bytes": 1}' > "$K/usage.json"; echo '{"default_branch": null}' > "$K/repo.json"
kc list >/dev/null 2>&1 && no "keep-check list accepted an unreadable default branch" || ok "keep-check list: an unreadable default branch fails"
echo '{"default_branch": "ccr-x"}' > "$K/repo.json"
# verify / progress (ruling 51): a restored entry is a sealed one, checked without any token
ka="$K/assets"; d=2026-09-21
mkka() { rm -rf "$ka" "$K/plain"; mkdir -p "$K/plain"; echo "secret-body" > "$K/plain/units-$d.tar.part00"; DATA_STORE_TOKEN=tk bash "$here/cache-crypt.sh" seal "$K/plain" "$ka" "data-rpc-assets-$d-" >/dev/null 2>&1; }
mkka; : > "$K/sum"
o=$(env -u DATA_STORE_TOKEN bash -c 'KG="$1" GH_BIN="$2" GITHUB_REPOSITORY=o/r GITHUB_STEP_SUMMARY="$3" bash "$4" verify "$5" "$6"' _ "$K" "$K/bin/gh" "$K/sum" "$here/keep-check.sh" $d "$ka" 2>&1) &&
  grep -q "| $d | verify: sealed, [0-9]* bytes |" "$K/sum" && [[ "$o" != *secret-body* ]] && ok "keep-check verify: a sealed entry passes without a token, printing its size only" || no "keep-check verify intact: $o"
bad=""
mkka; echo x > "$ka/extra.bin"; kc verify $d "$ka" >/dev/null 2>&1 && bad+=" extra"
mkka; rm "$ka/progress.mac"; kc verify $d "$ka" >/dev/null 2>&1 && bad+=" missing"
mkka; : > "$ka/progress.enc"; kc verify $d "$ka" >/dev/null 2>&1 && bad+=" empty"
rm -rf "$ka"; mkdir -p "$ka"; echo secret-body > "$ka/SHA256SUMS-$d"; kc verify $d "$ka" >/dev/null 2>&1 && bad+=" unsealed"
[[ -z "$bad" ]] && ok "keep-check verify: an extra or missing file, an empty ciphertext or an unsealed entry fails" || no "keep-check verify:$bad"
: > "$K/sum"; : > "$K/out"; echo '{"active_caches_size_in_bytes": 1000}' > "$K/usage.json"
kcache "data-rpc-2026-09-21-$KD-37220726125-1,3400000000,2026-10-04T20:00:00Z,,2026-10-04T20:00:00Z" \
  "data-rpc-2026-09-21-$KD-37240347289-1,3600000000,2026-10-05T01:18:00Z,,2026-10-05T01:18:00Z" \
  "data-rpc-2026-09-21-$KD-37240347289-1-qa,3600000000,2026-10-05T01:30:00Z,,2026-10-05T01:30:00Z" \
  "data-rpc-2026-09-21-$KD-37250000000-1,3700000000,2026-10-05T02:00:00Z,refs/pull/9/merge,2026-10-05T02:00:00Z" \
  "data-rpc-2026-09-21-37260000000-1,3800000000,2026-10-05T03:00:00Z,,2026-10-05T03:00:00Z" \
  "data-rpc-2026-09-20-$KD-5-2,1000000000,2026-10-03T00:00:00Z,,2026-10-03T00:00:00Z" \
  "data-rpc-assets-2026-09-20-$KD-3-1,4000000000,2026-10-06T01:00:00Z"
kc list >/dev/null && grep -qx 'count=2' "$K/out" &&
  grep -qx 'entries=\[{"key":"data-rpc-assets-2026-09-20-'$KD'-3-1","day":"2026-09-20","before":"2026-10-06T01:00:00Z","kind":"assets"},{"key":"data-rpc-2026-09-21-'$KD'-37240347289-1","day":"2026-09-21","before":"2026-10-05T01:18:00Z","kind":"progress"}\]' "$K/out" &&
  grep -q "| \`data-rpc-2026-09-21-$KD-37240347289-1\` | progress | 3.60 GB |" "$K/sum" && ! grep -q -- "-qa\|37220726125\|37250000000\|37260000000" "$K/out" &&
  ok "keep-check list: per unpackaged day the newest sealed default-branch progress entry; a day with assets keeps only its assets; older runs, -qa copies, other refs and unsealed entries are not kept" || no "keep-check list progress: $(cat "$K/out")"
kp="$K/prog"; rm -rf "$kp" "$K/pp"; mkdir -p "$K/pp/units/1039/1-2"; echo '{"blocks": 1}' > "$K/pp/units/1039/1-2/stats.json"
DATA_STORE_TOKEN=tk bash "$here/cache-crypt.sh" seal "$K/pp" "$kp" data-rpc-2026-09-21- >/dev/null 2>&1
: > "$K/sum"; o=$(kc progress 2026-09-21 "$kp" 2>&1) && grep -q "| 2026-09-21 | progress: sealed, [0-9]* bytes |" "$K/sum" && [[ "$o" != *blocks* ]] &&
  ok "keep-check progress: a sealed progress entry passes without a token, its size only" || no "keep-check progress: $o"
bad=""
rm "$kp/progress.kid"; kc progress 2026-09-21 "$kp" >/dev/null 2>&1 && bad+=" missing"
rm -rf "$kp"; mkdir -p "$kp/units"; kc progress 2026-09-21 "$kp" >/dev/null 2>&1 && bad+=" unsealed"
[[ -z "$bad" ]] && ok "keep-check progress: a missing sealed file or an unsealed progress fails" || no "keep-check progress:$bad"
kcache "data-rpc-assets-2026-09-21-1-1,5,2026-10-07T03:00:00Z"
kc touched data-rpc-assets-2026-09-21-1-1 2026-10-07T02:00:00Z >/dev/null && ok "keep-check touched: a later last_accessed_at proves the restore refreshed the entry" || no "keep-check touched later"
rc=0; KEEP_WAIT=2 kc touched data-rpc-assets-2026-09-21-1-1 2026-10-07T03:00:00Z >/dev/null 2>&1 || rc=$?
rc2=0; KEEP_WAIT=0 kc touched data-rpc-assets-2026-09-21-9-9 2026-10-07T03:00:00Z >/dev/null 2>&1 || rc2=$?
[[ $rc == 1 && $rc2 == 1 ]] && ok "keep-check touched: an unchanged last access (after the wait) or a vanished entry fails" || no "keep-check touched unchanged: $rc $rc2"
! grep -qv '^repos/o/r/actions/cache\|^repos/o/r$' "$K/calls.log" && ok "keep-check: the only API calls are cache reads and the default branch" || no "keep-check calls: $(sort -u "$K/calls.log")"

# ---- OF-2: the allow-list, the arm, the retention, the store and the 3-failure stop at every entry point ----
gdreset
# sd DAY [FIXTURE_CI]: scan-day.sh with a fresh pass for DAY (unless NOPASS); cd_ DAY: check-day.sh likewise.
sd() { local o="$T/of2sd"; rm -rf "$o"; mkdir -p "$o"; SDAY=$1 SFX=${2:-$FX} scan "$o"; }
bad=""
for d in 2026-09-25 2026-07-21 2026-09-21; do
  rc=0; guard full "$d" || rc=$?
  [[ $rc == 2 && ! -e "$GD/gh.log" ]] && grep -qE "is not in the archive allow-list|is a Helius day" "$T/gout.txt" || bad+=" plan:$d:$rc"
  rc=0; sd "$d" || rc=$?
  [[ $rc == 2 && ! -s "$T/calls.log" ]] && grep -qE "is not in the archive allow-list|is a Helius day" "$T/out.txt" || bad+=" scan-day:$d:$rc"
  rc=0; CDAY=$d cdrun of2 0 || rc=$?
  [[ $rc == 2 && ! -s "$T/zs.args" ]] && grep -qE "is not in the archive allow-list|is a Helius day" "$T/summary.md" || bad+=" check-day:$d:$rc"
done
[[ -z "$bad" ]] && ok "OF-2: 09-25 (holdout), 07-21 (before 07-22) and 09-21 (Helius) are refused, armed and with a guard pass, by the plan job's guard (a manual dispatch), scan-day.sh and check-day.sh before any request (archive-check never queues them, above)" || no "OF-2 day refusals:$bad"
bad=""
# A misconfigured allow-list never reaches 09-21, the holdout or a pre-BOOST day.
for l in "2026-07-22..2026-09-21" "2026-09-22" "2026-07-21..2026-07-23" "2026-07-22..x" "2026-08-02..2026-08-01"; do
  mkfx "$T/fxbad" "ARCHIVE_DAYS=$l"; rc=0; FXG=$T/fxbad/research/historical/ci guard local 2026-07-22 || rc=$?
  [[ $rc == 2 ]] && grep -q "ARCHIVE_DAYS in archive-limits.conf is malformed" "$T/gout.txt" || bad+=" [$l]:$rc"
done
[[ -z "$bad" ]] && ok "OF-2: an ARCHIVE_DAYS that holds 09-21, a holdout day or a day before 07-22, or is malformed, refuses every day" || no "OF-2 bad list:$bad"
bad=""
# Unarmed: today's archive-limits.conf.
mkfx "$T/fxunarmed" ARCHIVE_ARM=
rc=0; FXG=$here guard full 2026-07-22 || rc=$?
[[ $rc == 2 && ! -e "$GD/gh.log" ]] && grep -q "the archive chain is not armed" "$T/gout.txt" || bad+=" plan:$rc"
rc=0; sd 2026-07-22 "$T/fxunarmed/research/historical/ci" || rc=$?
[[ $rc == 2 && ! -s "$T/calls.log" ]] && grep -q "not armed" "$T/out.txt" || bad+=" scan-day:$rc"
rc=0; CFX=$T/fxunarmed/research/historical/ci cdrun of2 0 || rc=$?
[[ $rc == 2 && ! -s "$T/zs.args" ]] && grep -q "not armed" "$T/summary.md" || bad+=" check-day:$rc"
mkfx "$T/fxrearm" ARCHIVE_REARM_AT=2099-01-01T00:00:00Z
rc=0; FXG=$T/fxrearm/research/historical/ci guard full 2026-07-22 || rc=$?
[[ $rc == 2 ]] && grep -q "ARCHIVE_REARM_AT .* is not a past UTC time" "$T/gout.txt" || bad+=" rearm-future:$rc"
[[ -z "$bad" ]] && ok "OF-2: unarmed (today's ARCHIVE_ARM, empty) a manual dispatch is refused at the plan job, and scan-day.sh and check-day.sh refuse too; an ARCHIVE_REARM_AT in the future is refused" || no "OF-2 unarmed entry points:$bad"
bad=""
# Retention: unset → 07-22 only (K2); K2 → 07-22 and 07-23; K3 → every day.
mkfx "$T/fxret0" ARCHIVE_RETENTION=
FXG=$T/fxret0/research/historical/ci guard full 2026-07-22 && [[ $(grep -vE "^(permissions: parsed with|run history: )" "$T/gout.txt") == K2 ]] || bad+=" unset-07-22"
rc=0; FXG=$T/fxret0/research/historical/ci guard full 2026-07-23 || rc=$?
[[ $rc == 2 ]] && grep -q "2026-07-23 has no retention value" "$T/gout.txt" || bad+=" unset-07-23:$rc"
echo 2026-07-22 > "$GD/published"; guard full 2026-07-23 && [[ $(grep -vE "^(permissions: parsed with|run history: )" "$T/gout.txt") == K2 ]] || bad+=" K2-07-23"; rm -f "$GD/published"
rc=0; guard full 2026-07-24 || rc=$?
[[ $rc == 2 ]] && grep -q "2026-07-24 has no retention value" "$T/gout.txt" || bad+=" K2-07-24:$rc"
rc=0; sd 2026-07-24 || rc=$?
[[ $rc == 2 && ! -s "$T/calls.log" ]] || bad+=" scan-day-K2-07-24:$rc"
rc=0; CDAY=2026-07-24 cdrun of2 0 || rc=$?
[[ $rc == 2 && ! -s "$T/zs.args" ]] || bad+=" check-day-K2-07-24:$rc"
d=2026-07-22; while [[ "$d" < 2026-08-21 ]]; do echo "$d"; d=$(date -u -d "$d + 1 day" +%F); done > "$GD/published"
FXG=$T/fxk3/research/historical/ci guard full 2026-08-21 && [[ $(grep -vE "^(permissions: parsed with|run history: )" "$T/gout.txt") == K3 ]] || bad+=" K3-08-21"; rm -f "$GD/published"
mkfx "$T/fxretx" ARCHIVE_RETENTION=K1
rc=0; FXG=$T/fxretx/research/historical/ci guard full 2026-07-22 || rc=$?; [[ $rc == 2 ]] || bad+=" K1:$rc"
[[ -z "$bad" ]] && ok "OF-2 retention: 07-23 with no retention value refused (unset allows only 07-22, K2); 07-24 with K2 refused at the plan job, scan-day.sh and check-day.sh; K3 allows 08-21; an unknown value allows no day" || no "OF-2 retention:$bad"
bad=""
# The store and the 3-failure stop at the plan job, and through the guard pass at
# scan-day.sh and check-day.sh.
rc=0; guard full 2026-07-22 && [[ $(grep -vE "^(permissions: parsed with|run history: )" "$T/gout.txt") == K2 ]] || bad+=" control"
rc=0; GD_STOP=1 guard full 2026-07-22 || rc=$?
[[ $rc == 2 ]] && grep -q "the storage-stop marker is present in o/data" "$T/gout.txt" || bad+=" plan-stop:$rc"
rm -rf "$GP"; rc=0; GD_STOP=1 guard attest 2026-07-22 "$GP" || rc=$?
[[ $rc == 2 && ! -e "$GP/2026-07-22" ]] || bad+=" attest-stop:$rc"
rc=0; NOPASS=1 sd 2026-07-22 || rc=$?
[[ $rc == 2 && ! -s "$T/calls.log" ]] && grep -q "no archive guard pass for 2026-07-22" "$T/out.txt" || bad+=" scan-day-stop:$rc"
rc=0; NOPASS=1 cdrun of2 0 || rc=$?
[[ $rc == 2 && ! -s "$T/zs.args" ]] && grep -q "no archive guard pass for 2026-07-22" "$T/summary.md" || bad+=" check-day-stop:$rc"
[[ -z "$bad" ]] && ok "OF-2: the storage-stop marker present → a manual dispatch refused at the plan job, the scan job's guard step writes no pass, and scan-day.sh and check-day.sh refuse without one" || no "OF-2 storage-stop:$bad"
bad=""
for v in GD_STORE_FAIL GD_PUBLIC; do rc=0; eval "$v=1 guard full 2026-07-22" || rc=$?; [[ $rc == 2 ]] && grep -q "store" "$T/gout.txt" || bad+=" $v:$rc"; done
rc=0; DATA_STORE_TOKEN= GD="$GD" GH_BIN="$GD/bin/gh" GH_REPO=o/r DATA_REPO=o/data GH_TOKEN=x GITHUB_REF=refs/heads/main GITHUB_RUN_ATTEMPT=1 bash "$FX/archive-guard.sh" full 2026-07-22 > "$T/gout.txt" 2>&1 || rc=$?
[[ $rc == 2 ]] && grep -q "the private store cannot be read" "$T/gout.txt" || bad+=" no-token:$rc"
[[ -z "$bad" ]] && ok "OF-2: zeroed-data unreadable, public, or without a token → refused at the plan job" || no "OF-2 store unreadable:$bad"
bad=""
now=$(date -u +%s)
{ dsrun 411 "data-scan scan source=archive" failure 500 420 "scan (2026-07-22)=failure,continue=failure"
  dsrun 412 "data-scan scan source=archive" failure 400 360 "scan (2026-07-22)=failure,continue=failure"; } | dsjson
acrun 413 failure 300 notserved | acjson
rc=0; guard full 2026-07-22 || rc=$?
[[ $rc == 2 ]] && grep -q "the archive chain is stopped: 3 failures since ARCHIVE_REARM_AT" "$T/gout.txt" || bad+=" plan:$rc"
rm -rf "$GP"; rc=0; guard attest 2026-07-22 "$GP" || rc=$?
[[ $rc == 2 && ! -e "$GP/2026-07-22" ]] || bad+=" attest:$rc"
rc=0; GD_RUNS_FAIL=1 guard full 2026-07-22 || rc=$?
[[ $rc == 2 ]] && grep -q "the run history cannot be read" "$T/gout.txt" || bad+=" unreadable:$rc"
mkfx "$T/fxr5" ARCHIVE_REARM_AT="$(iso $(( now - 5 * 3600 - 60 )))"
FXG=$T/fxr5/research/historical/ci guard full 2026-07-22 || bad+=" rearmed"
[[ -z "$bad" ]] && ok "OF-2: a manual dispatch after 3 failures (2 blocked batches and a non-served check) is refused at the plan job and gets no guard pass; an unreadable history refuses; a later ARCHIVE_REARM_AT lets it through" || no "OF-2 3-failure stop at entry points:$bad"
bad=""
gdreset
# A pinned PM-01 migration list line (OF-3), for K3 reads.
attr_list_line="8rjKP44zZewzNGx6DyF3Ck1Ub6y45pXbures2Dx3pump 100 200"
# The guard pass: fresh, for this day.
o="$T/of2p"; rm -rf "$o"; mkdir -p "$o" "$GP"
echo "2026-07-22 K2 $(( $(date -u +%s) - 1801 ))" > "$GP/2026-07-22"
rc=0; ARCHIVE_GO="$T/archive10.go" ARCHIVE_GUARD_DIR="$GP" PATH="$S:$PATH" GITHUB_STEP_SUMMARY="$T/summary.md" bash "$FX/scan-day.sh" 2026-07-22 "$o" 40 300 > "$T/out.txt" 2>&1 || rc=$?
[[ $rc == 2 ]] && grep -q "older than 30 min" "$T/out.txt" || bad+=" stale:$rc"
echo "2026-07-23 K2 $(date -u +%s)" > "$GP/2026-07-22"
rc=0; ARCHIVE_GO="$T/archive10.go" ARCHIVE_GUARD_DIR="$GP" PATH="$S:$PATH" GITHUB_STEP_SUMMARY="$T/summary.md" bash "$FX/scan-day.sh" 2026-07-22 "$o" 40 300 > "$T/out.txt" 2>&1 || rc=$?
[[ $rc == 2 ]] || bad+=" other-day:$rc"
rm -rf "$GP"; guard attest 2026-07-22 "$GP" && read -r d r t < "$GP/2026-07-22" && [[ "$d $r" == "2026-07-22 K2" ]] || bad+=" attest-writes"
[[ -z "$bad" ]] && ok "OF-2: a guard pass older than 30 min, or for another day, is refused; the guard step writes 'DAY RETENTION TIME'" || no "OF-2 guard pass:$bad"
bad=""
# Retention passed to the scanner and the rescan: the day's recorded one wins.
sd 2026-07-22 >/dev/null; [[ " $(cat "$T/scan.args") " == *" -retention K2 "* ]] || bad+=" fresh-K2:$(cat "$T/scan.args")"
o="$T/of2k"; rm -rf "$o"; mkdir -p "$o/units/1046/1-2"; echo '{"scanner_revision": "r1", "retention": "K2"}' > "$o/units/1046/1-2/stats.json"
SDAY=2026-07-22 SFX=$T/fxk3/research/historical/ci PASSRET=K3 scan "$o" || bad+=" reread-rc"
[[ " $(cat "$T/scan.args") " == *" -retention K2 "* ]] || bad+=" reread:$(cat "$T/scan.args")"
o="$T/of2f"; rm -rf "$o"; mkdir -p "$o"
echo "$attr_list_line" > "$T/k3list.txt"
SDAY=2026-07-24 SFX=$T/fxk3/research/historical/ci PASSRET=K3 scan "$o" && [[ " $(cat "$T/scan.args") " == *" -retention K2 "* && " $(cat "$T/scan.args") " != *" -migration-list "* ]] || bad+=" fresh-K3-read-at-K2"
o="$T/of2m"; rm -rf "$o"; mkdir -p "$o/units/1046/1-2" "$o/units/1046/3-4"; echo '{"scanner_revision": "r1", "retention": "K2"}' > "$o/units/1046/1-2/stats.json"; echo '{"scanner_revision": "r1", "retention": "K3"}' > "$o/units/1046/3-4/stats.json"
rc=0; PASSRET=K3 SDAY=2026-07-22 SFX=$T/fxk3/research/historical/ci scan "$o" || rc=$?
[[ $rc == 2 && ! -s "$T/calls.log" ]] && grep -q "record retention 'K2 K3 '" "$T/out.txt" || bad+=" mixed:$rc"
[[ -z "$bad" ]] && ok "OF-2/OF-3: scan-day passes the retention to the scanner explicitly: -retention K2 for 07-22, and K2 for 07-24 under K3 too (every day is read at K2 and trimmed, OF-3 ruling 2); a unit re-read on a K2 day uses K2 after ARCHIVE_RETENTION became K3; units mixing K2 and K3 are refused" || no "OF-2 scan retention:$bad"
bad=""
# (the stub's rescan writes no files, so the byte comparison after it fails: only the call is checked)
cdrun of2 0 || true
grep -q '^unit .* -retention K2 ' "$T/zs.args" || bad+=" K2:$(grep '^unit' "$T/zs.args")"
CDPASS=K3 CFX=$T/fxk3/research/historical/ci cdrun of2 0 || true
grep -q '^unit .* -retention K2 ' "$T/zs.args" || bad+=" K2-under-K3"
rc=0; CDRET=none cdrun of2 0 || rc=$?
[[ $rc == 2 && ! -s "$T/zs.args" ]] || bad+=" none:$rc"
rc=0; CFX=$T/fxret0/research/historical/ci CDAY=2026-07-23 cdrun of2 0 || rc=$?
[[ $rc == 2 && ! -s "$T/zs.args" ]] && grep -q "2026-07-23 has no retention value" "$T/summary.md" || bad+=" cfg-none:$rc"
[[ -z "$bad" ]] && ok "OF-2: check-day's determinism rescan of a K2 day runs with -retention K2 (also after ARCHIVE_RETENTION became K3); units with no recorded retention, or a day with no retention value, are refused before any call" || no "OF-2 check-day retention:$bad"
bad=""
# The plan job (a manual dispatch): one archive day a batch, the guard step after the
# validation, the scan job's guard steps before the scan and before QA.
plan SOURCE=archive DAYS=2026-07-22,2026-07-23 MAX_CREDITS=0 && bad+=" two-days"
plan SOURCE=archive DAYS=2026-07-22 MAX_CREDITS=0 && grep -qx "archive_day=2026-07-22" "$T/plan.out" || bad+=" one-day"
python3 - "$here/../../../.github/workflows/data-scan.yml" <<'PY' || bad+=" structure"
import sys, yaml
wf = yaml.safe_load(open(sys.argv[1]))
plan = wf["jobs"]["plan"]
assert plan["permissions"] == {"contents": "read", "actions": "read"}, plan["permissions"]
ps = plan["steps"]
assert ps[0]["uses"].startswith("actions/checkout@") and ps[0]["with"]["persist-credentials"] is False, ps[0]
assert [s.get("id") or s.get("name") for s in ps[1:]] == ["days", "Archive guard"], ps
g = ps[2]
assert g["if"] == "inputs.mode == 'scan' && inputs.source != 'helius'" and g["env"]["DAY"] == "${{ steps.days.outputs.archive_day }}", g
assert g["run"].endswith('/research/historical/ci/archive-guard.sh" full "$DAY"') and "github.token" in g["env"]["GH_TOKEN"], g
steps = wf["jobs"]["scan"]["steps"]
ids = [s.get("id") or s.get("name") for s in steps]
assert ids.index("guardscan") == ids.index("scan") - 1 and ids.index("guardqa") == ids.index("qa") - 1, ids
for k, tail in (("guardscan", ""), ("guardqa", " qa")):
    s = steps[ids.index(k)]
    assert s["if"] == "steps.published.outputs.complete != 'true' && inputs.source != 'helius'", s
    assert s["run"].endswith('/research/historical/ci/archive-guard.sh" attest "$DAY" "$RUNNER_TEMP/archive-guard"' + tail) and s["env"]["DAY"] == "${{ matrix.day }}", s
for k in ("scan", "qa"):
    s = steps[ids.index(k)]
    assert s["env"]["ARCHIVE_GUARD_DIR"] == "${{ runner.temp }}/archive-guard" and "always()" not in s["if"], s
    assert "github.token" not in str(s) and "DATA_STORE_TOKEN" not in str(s), s
txt = open(sys.argv[1]).read()
assert not any(k in txt for k in ("GH_BIN", "AG_NOW", "ARCHIVE_CHECK_URL", "CURL_BIN")), "test-only overrides in data-scan.yml"
PY
[[ -z "$bad" ]] && ok "OF-2 data-scan: an archive scan is one day; the plan job (checkout, actions: read) runs archive-guard.sh full on it after validation; the scan job runs the guard (attest, clean shell, token) right before the scan and before QA, whose steps hold no token" || no "OF-2 data-scan wiring:$bad"
bad=""
# The continue job: one resumable restart a day for the archive.
python3 - "$here/../../../.github/workflows/data-scan.yml" > "$T/cont.sh" <<'PY'
import sys, yaml
print(next(st for st in yaml.safe_load(open(sys.argv[1]))["jobs"]["continue"]["steps"] if st.get("name") == "Dispatch the next run if a day stopped resumably")["run"])
PY
# It runs from the checkout (the fixture) with the guard's gh stub: the artifacts list
# names resume-2026-07-22; restarts come from run history, per day (ruling 5).
cont() { rm -f "$GD/dispatch.log"; (cd "$T/fx" && env PATH="$GD/bin:$PATH" GD="$GD" GH_REPO=o/r GITHUB_RUN_ATTEMPT=1 RUN_ID=1 REF=main DAYS=2026-07-22 MAX_MBPS=40 MAX_CREDITS=0 RPC_RPS=5 EXPECT_UNITS= REREAD_ID= MAX_CHAIN=12 GITHUB_STEP_SUMMARY="$T/cont.sum" "$@" bash "$T/cont.sh") > "$T/cont.out" 2>&1; }
gdreset
dsrun 341 "data-scan scan source=archive" failure 300 290 "scan (2026-07-22)=failure,continue=success" | dsjson
rc=0; cont CHAIN=0 SOURCE=archive || rc=$?
[[ $rc == 1 && ! -e "$GD/dispatch.log" ]] && grep -q "second resumable stop on 2026-07-22: counted as a failure" "$T/cont.out" || bad+=" archive-second-by-day:$rc"
dsrun 342 "data-scan scan source=archive" failure 300 290 "scan (2026-07-21)=failure,continue=success" | dsjson
cont CHAIN=5 SOURCE=archive && grep -q -- '-f chain=6 -f source=archive' "$GD/dispatch.log" || bad+=" archive-other-day"
rm -f "$GD/ds.json"; cont CHAIN=0 SOURCE=archive && grep -q -- '-f chain=1 -f source=archive' "$GD/dispatch.log" || bad+=" archive-first"
dsrun 341 "data-scan scan source=archive" failure 300 290 "scan (2026-07-22)=failure,continue=success" | dsjson
cont CHAIN=1 SOURCE=helius && grep -q -- '-f chain=2 -f source=helius' "$GD/dispatch.log" || bad+=" helius-second"
rc=0; cont CHAIN=0 SOURCE=archive GD_RUNS_FAIL=1 || rc=$?; [[ $rc == 1 && ! -e "$GD/dispatch.log" ]] || bad+=" history-unreadable:$rc"
gdreset
[[ -z "$bad" ]] && ok "OF-2: the continue job allows one resumable restart a day for the archive, counted per day from run history (a second exit 75 of 07-22 fails it whatever inputs.chain says; another day's restart does not count; an unreadable history stops); Helius chains are unchanged" || no "OF-2 continue:$bad"
bad=""
# The repository's values: 30 days; 31 with the 07-22 lead-in, unarmed, retention unset, re-arm time valid.
( . "$here/archive-limits.conf"; . "$here/archive-guard.sh"
  days=$(ag_days) && [[ $(wc -l <<< "$days") == 31 && $(head -1 <<< "$days") == 2026-07-22 && $(tail -1 <<< "$days") == 2026-08-21 ]] &&
  ! grep -qx 2026-09-21 <<< "$days" && [[ " $HELIUS_DAYS " == *" 2026-09-21 "* && -z "$ARCHIVE_ARM" && -z "$ARCHIVE_RETENTION" ]] &&
  ag_ts "$ARCHIVE_REARM_AT" >/dev/null && [[ "$(ag_pinned_id)" == b10pull-of-1 ]] && ! ag_armed >/dev/null 2>&1 ) &&
  ok "OF-2 archive-limits.conf: ARCHIVE_DAYS is exactly 2026-07-22..2026-08-21 (30 days; 31 with the 07-22 lead-in; 09-21 stays in HELIUS_DAYS only), ARCHIVE_ARM and ARCHIVE_RETENTION empty, ARCHIVE_REARM_AT a valid UTC time; the one pinned B10-PULL row (OF-7) is b10pull-of-1 and the chain stays unarmed" || no "OF-2 repository values"

# ---- OF-3: K3 reads take the pinned migration list; the K2 release keeps the rescan hashes and the per-unit log; the trim ----
gdreset; bad=""
echo "$attr_list_line" > "$T/k3list.txt"; k3sha=$(sha256sum "$T/k3list.txt" | cut -d' ' -f1)
# OF-3 ruling 2: a K3 day is read at K2 (no list at scan time); a trimmed day (units
# recording K3) is never read again here. Ruling 3: the K2 peak must fit first.
o="$T/of3s"; rm -rf "$o"; mkdir -p "$o/units/1046/1-2"; echo '{"scanner_revision": "r1", "retention": "K3"}' > "$o/units/1046/1-2/stats.json"
rc=0; SDAY=2026-07-24 SFX=$T/fxk3/research/historical/ci PASSRET=K3 scan "$o" || rc=$?
[[ $rc == 2 && ! -s "$T/calls.log" ]] && grep -q "record retention K3 but the day is not a complete trimmed day" "$T/out.txt" || bad+=" trimmed-day:$rc"
peak=$(. "$here/archive-limits.conf"; echo "${ARCHIVE_K2_PEAK_BYTES:-0}")
o="$T/of3d"; rm -rf "$o"; mkdir -p "$o"; rc=0; FAKE_AVAIL=$(( peak - 1 )) SDAY=2026-07-24 SFX=$T/fxk3/research/historical/ci PASSRET=K3 scan "$o" || rc=$?
[[ $rc == 2 && ! -s "$T/calls.log" ]] && grep -q "a K2 day" "$T/out.txt" || bad+=" disk-short:$rc"
rc=0; FAKE_AVAIL=$peak SDAY=2026-07-24 SFX=$T/fxk3/research/historical/ci PASSRET=K3 scan "$o" || rc=$?
[[ $rc == 0 && $(calls) == "scan " ]] || bad+=" disk-exact:$rc"
(( peak == 55000000000 )) || bad+=" peak-value"
[[ -z "$bad" ]] && ok "OF-3 rulings 2-3: a K3 day is read at K2 (no list at scan time); units already trimmed to K3 are refused (never read again); one byte short of ARCHIVE_K2_PEAK_BYTES (55 GB) is refused before any scanner call, exactly that much scans" || no "OF-3 read at K2:$bad"
bad=""
# check-day on a trimmed (K3) day: the rescan reads the unit at K2 and must equal the K2
# hashes in the per-unit log; no log, or another hash, fails.
C4="$T/cd4bin"; mkdir -p "$C4"; cp "$C/node" "$C4/node"
cat > "$C4/zeroed-scan" <<'STUB'
#!/usr/bin/env bash
echo "$*" >> "$T/zs.args"
case $1 in
  finalize) while (( $# )); do [[ "$1" == -dataset ]] && ds=$2; shift; done; mkdir -p "$ds/qa"; echo '{}' > "$ds/manifest.json" ;;
  unit) while (( $# )); do case $1 in -out) o=$2 ;; -epoch) e=$2 ;; -from-slot) f=$2 ;; -to-slot) t=$2 ;; esac; shift; done
        mkdir -p "$o/units/$e/$f-$t"; echo k2-bytes > "$o/units/$e/$f-$t/raw_canonical.jsonl.zst"; echo b > "$o/units/$e/$f-$t/blocks.csv.zst" ;;
esac
STUB
chmod +x "$C4/zeroed-scan"
k2h=$(echo k2-bytes | sha256sum | cut -d' ' -f1); bh=$(echo b | sha256sum | cut -d' ' -f1)
cdk3() { rm -rf "$T/cd-k3" "$T/cd-assets-k3"; mkdir -p "$T/cd-k3/units/1046/1-2" "$T/cd-ds"; echo x > "$T/cd-k3/units/1046/1-2/blocks.csv.zst"
  echo '{"scanner_revision": "r1", "retention": "K3", "migration_list_sha256": "abc"}' > "$T/cd-k3/units/1046/1-2/stats.json"
  [[ "$1" == nolog ]] || printf '1046/1-2 r1 K3 abc\nk2 %s 1046/1-2/blocks.csv.zst\nk2 %s 1046/1-2/raw_canonical.jsonl.zst\n' "$bh" "$1" > "$T/cd-k3/units.log"
  : > "$T/zs.args"; : > "$T/summary.md"; gpass 2026-07-24 K3
  ARCHIVE_GO="$T/archive10.go" ARCHIVE_GUARD_DIR="$GP" FAKE_AVAIL=999000000000 DATASET_PARENT="$T/cd-ds" PATH="$C4:$PATH" GITHUB_STEP_SUMMARY="$T/summary.md" \
    bash "$T/fxk3/research/historical/ci/check-day.sh" 2026-07-24 "$T/cd-k3" "$T/cd-assets-k3" > "$T/out.txt" 2>&1; }
rc=0; cdk3 "$k2h" || rc=$?
[[ $rc == 0 ]] && grep -q "^unit .* -retention K2 -max-mbps " "$T/zs.args" && cmp -s "$T/cd-k3/units.log" "$T/cd-assets-k3/units-2026-07-24.log" || bad+=" match:$rc:$(tail -2 "$T/out.txt")"
rc=0; cdk3 "$(echo other | sha256sum | cut -d' ' -f1)" || rc=$?; [[ $rc == 1 ]] && grep -q "differs from the logged K2 hashes" "$T/out.txt" || bad+=" mismatch:$rc"
rc=0; cdk3 nolog || rc=$?; [[ $rc == 2 && ! -s "$T/zs.args" ]] || bad+=" nolog:$rc"
[[ -z "$bad" ]] && ok "OF-3: check-day's rescan of a trimmed day reads the unit at K2 and must equal the K2 hashes kept in the per-unit log (which goes into the assets); another hash fails, no log is refused before any call" || no "OF-3 check-day K3:$bad"
bad=""
# A passing determinism rescan: the assets keep the rescan unit's hashes (equal to the
# day's unit) and the per-unit log; package-day puts both in SHA256SUMS-DAY.
C3="$T/cd3bin"; mkdir -p "$C3"; cp "$C/node" "$C3/node"
cat > "$C3/zeroed-scan" <<'STUB'
#!/usr/bin/env bash
echo "$*" >> "$T/zs.args"
case $1 in
  finalize) while (( $# )); do [[ "$1" == -dataset ]] && ds=$2; shift; done; mkdir -p "$ds/qa"; echo '{}' > "$ds/manifest.json" ;;
  unit) while (( $# )); do case $1 in -out) o=$2 ;; -epoch) e=$2 ;; -from-slot) f=$2 ;; -to-slot) t=$2 ;; -state) s=$2 ;; esac; shift; done
        mkdir -p "$o/units/$e/$f-$t"; cp "$s/units/$e/$f-$t/"*.zst "$o/units/$e/$f-$t/" ;;
  unitlog) echo "1046/1-2 r1 K2 -" ;;
esac
STUB
chmod +x "$C3/zeroed-scan"
rm -rf "$T/cd-ok" "$T/cd-assets-ok"; mkdir -p "$T/cd-ok/units/1046/1-2" "$T/cd-ds"; echo x > "$T/cd-ok/units/1046/1-2/blocks.csv.zst"; echo y > "$T/cd-ok/units/1046/1-2/raw_canonical.jsonl.zst"
echo '{"scanner_revision": "r1", "retention": "K2"}' > "$T/cd-ok/units/1046/1-2/stats.json"; : > "$T/zs.args"; gpass 2026-07-22 K2
rc=0; ARCHIVE_GO="$T/archive10.go" ARCHIVE_GUARD_DIR="$GP" FAKE_AVAIL=999000000000 DATASET_PARENT="$T/cd-ds" PATH="$C3:$PATH" GITHUB_STEP_SUMMARY="$T/summary.md" \
  bash "$FX/check-day.sh" 2026-07-22 "$T/cd-ok" "$T/cd-assets-ok" > "$T/out.txt" 2>&1 || rc=$?
want=$(cd "$T/cd-ok/units" && sha256sum -- 1046/1-2/*.zst)
[[ $rc == 0 && "$(cat "$T/cd-assets-ok/rescan-2026-07-22.sha256" 2>/dev/null)" == "$want" && "$(cat "$T/cd-assets-ok/units-2026-07-22.log" 2>/dev/null)" == "1046/1-2 r1 K2 -" ]] ||
  bad+=" check-day:$rc:$(tail -3 "$T/out.txt")"
for f in qa-2026-07-22.md qa-2026-07-22.json parity-2026-07-22.json manifest-2026-07-22.json; do [[ -f "$T/cd-assets-ok/$f" ]] || echo x > "$T/cd-assets-ok/$f"; done
FAKE_AVAIL=999000000000 GITHUB_STEP_SUMMARY="$T/summary.md" bash "$FX/package-day.sh" 2026-07-22 "$T/cd-ok" "$T/cd-assets-ok" > "$T/out.txt" 2>&1 || bad+=" package"
grep -q "  units-2026-07-22.log$" "$T/cd-assets-ok/SHA256SUMS-2026-07-22" && grep -q "  rescan-2026-07-22.sha256$" "$T/cd-assets-ok/SHA256SUMS-2026-07-22" || bad+=" sums"
[[ -z "$bad" ]] && ok "OF-3: after a passing determinism rescan the K2 release's assets list the rescan unit's file hashes (equal to the day's unit) and the per-unit log, and SHA256SUMS-DAY covers both" || no "OF-3 rescan hashes:$bad"
bad=""
# trim-day.sh: no network tool is ever called; the day's list = prior + its own
# migrations; per unit the unit is trimmed, its K2 hashes appended to units.log.partial
# (fsynced) and its K2 copy deleted; the per-unit log checked; QA only with --qa.
TB="$T/trimbin"; mkdir -p "$TB"; cp "$C/node" "$TB/node"
for x in gh curl wget; do printf '#!/usr/bin/env bash\necho "%s $*" >> "$T/net.log"; exit 1\n' "$x" > "$TB/$x"; done
cat > "$TB/zeroed-scan" <<'STUB'
#!/usr/bin/env bash
echo "$*" >> "$T/trim.args"
case $1 in
  migrations) echo "8rjKP44zZewzNGx6DyF3Ck1Ub6y45pXbures2Dx3pump 100 18100" ;;
  trim) echo "trim-counts kept=7 of 9" # (OF-3 ruling 24: kept in the day's logs/, never the job log)
        while (( $# )); do case $1 in -in) i=$2 ;; -out) o=$2 ;; -migration-list) l=$2 ;; esac; shift; done
        [[ -n "${TRIM_FAIL_ON:-}" && "$o" == *"$TRIM_FAIL_ON" ]] && exit 1
        mkdir -p "$o"; for f in "$i"/*.zst; do cp "$f" "$o/"; done
        printf '{"scanner_revision": "rF", "retention": "K3", "migration_list_sha256": "%s"}\n' "$(sha256sum "$l" | cut -d' ' -f1)" > "$o/stats.json" ;;
  unitlog) out=; chk=; while (( $# )); do case $1 in -out) out=$2 ;; -check) chk=$2 ;; esac; shift; done
        if [[ -n "$chk" ]]; then [[ -n "${TRIM_LOG_FAIL:-}" ]] && exit 2; exit 0; fi
        for st in "$out"/units/*/*/stats.json; do d=$(dirname "$st")
          printf '%s/%s %s %s %s\n' "$(basename "$(dirname "$d")")" "$(basename "$d")" "$(sed -n 's/.*"scanner_revision": "\([^"]*\)".*/\1/p' "$st")" \
            "$(sed -n 's/.*"retention": "\([^"]*\)".*/\1/p' "$st")" "$(sed -n 's/.*"migration_list_sha256": "\([^"]*\)".*/\1/p' "$st")"; done | LC_ALL=C sort ;;
  finalize) while (( $# )); do [[ "$1" == -dataset ]] && ds=$2; shift; done; mkdir -p "$ds/qa"; echo '{}' > "$ds/manifest.json" ;;
esac
STUB
chmod +x "$TB"/*
# two K2 units; files named so the C locale order (B before a) differs from en_US's
mkk2() { rm -rf "$T/tk2" "$T/tassets" "$T/trim.args" "$T/net.log"; mkdir -p "$T/tk2/units/1046/1-2" "$T/tk2/units/1046/3-4" "$T/cd-ds"
  for u in 1-2 3-4; do echo '{"scanner_revision": "rF", "retention": "K2"}' > "$T/tk2/units/1046/$u/stats.json"
    echo "raw$u" > "$T/tk2/units/1046/$u/raw_canonical.jsonl.zst"; echo "B$u" > "$T/tk2/units/1046/$u/B.zst"; echo "a$u" > "$T/tk2/units/1046/$u/a.zst"; done; }
td() { local d=$1 p=$2; shift 2; FAKE_AVAIL=999000000000 DATASET_PARENT="$T/cd-ds" PATH="$TB:$PATH" GITHUB_STEP_SUMMARY="$T/summary.md" \
  ARCHIVE_PRIOR_SUMS="${TPS:-}" bash "$here/trim-day.sh" "$d" "$T/tk2" "$p" "$T/tassets" "$@" > "$T/out.txt" 2>&1; }
h() { echo "$1" | sha256sum | cut -d' ' -f1; }
mkk2; rc=0; td 2026-07-22 - || rc=$?
lsha=$(sha256sum "$T/tk2/list-2026-07-22.txt" 2>/dev/null | cut -d' ' -f1)
[[ $rc == 0 && $(grep -c "^trim -in $T/tk2/units/1046/[13]-[24] -out $T/tk2/units.k3/1046/[13]-[24] -migration-list $T/tk2/list-2026-07-22.txt$" "$T/trim.args") == 2 ]] || bad+=" trims:$rc:$(tail -2 "$T/out.txt")"
grep -q "^migrations -day-start $(date -u -d 2026-07-22 +%s) $T/tk2$" "$T/trim.args" && cmp -s "$T/tk2/list-2026-07-22.txt" "$T/tassets/list-2026-07-22.txt" || bad+=" list-own"
[[ ! -e "$T/tk2/units.k3" && ! -e "$T/tk2/units.log.partial" && "$(cat "$T/tk2/units/1046/1-2/a.zst" 2>/dev/null)" == a1-2 && $(grep -c '"K3"' "$T/tk2/units/1046/1-2/stats.json") == 1 ]] || bad+=" k2-replaced"
want=$(printf '%s\n' "1046/1-2 rF K3 $lsha" "1046/3-4 rF K3 $lsha" \
  "k2 $(h B1-2) 1046/1-2/B.zst" "k2 $(h a1-2) 1046/1-2/a.zst" "k2 $(h raw1-2) 1046/1-2/raw_canonical.jsonl.zst" \
  "k2 $(h B3-4) 1046/3-4/B.zst" "k2 $(h a3-4) 1046/3-4/a.zst" "k2 $(h raw3-4) 1046/3-4/raw_canonical.jsonl.zst")
[[ "$(cat "$T/tassets/units-2026-07-22.log" 2>/dev/null)" == "$want" ]] && cmp -s "$T/tk2/units.log" "$T/tassets/units-2026-07-22.log" || bad+=" log-C-sorted"
grep -q "^unitlog -out $T/tk2 -check $T/tk2/units.log$" "$T/trim.args" && ! grep -q "^finalize" "$T/trim.args" || bad+=" check-no-qa"
[[ ! -e "$T/net.log" ]] || bad+=" network:$(cat "$T/net.log")"
mkk2; td 2026-07-22 - --qa && grep -q "^finalize -out $T/tk2 " "$T/trim.args" && [[ -f "$T/tassets/qa-2026-07-22.md" && -f "$T/tassets/parity-2026-07-22.json" ]] || bad+=" qa"
mkk2; rc=0; td 2026-07-23 - || rc=$?; [[ $rc == 2 && ! -e "$T/trim.args" ]] && grep -q "needs the day before's pinned list" "$T/out.txt" || bad+=" no-prior:$rc"
mkprior 2026-07-23
mkk2; TPS=$PRIORS td 2026-07-23 "$PRIORL" && grep -q "^migrations -day-start $(date -u -d 2026-07-23 +%s) -prior $PRIORL $T/tk2$" "$T/trim.args" || bad+=" prior"
mkk2; rc=0; td 2026-07-23 "$PRIORL" || rc=$?; [[ $rc == 2 && ! -e "$T/trim.args" ]] || bad+=" prior-no-sums:$rc"
echo "$(printf '0%.0s' {1..64})  list-2026-07-22.txt" > "$T/badsums"
mkk2; rc=0; TPS=$T/badsums td 2026-07-23 "$PRIORL" || rc=$?; [[ $rc == 2 && ! -e "$T/trim.args" ]] && grep -q "is not the one the stored SHA256SUMS" "$T/out.txt" || bad+=" prior-bad-sum:$rc"
cp "$PRIORL" "$T/list-other.txt"; mkk2; rc=0; TPS=$PRIORS td 2026-07-23 "$T/list-other.txt" || rc=$?; [[ $rc == 2 ]] || bad+=" prior-wrong-name:$rc"
mkk2; echo '{"scanner_revision": "rF", "retention": "K1"}' > "$T/tk2/units/1046/3-4/stats.json"; rc=0; td 2026-07-22 - || rc=$?; [[ $rc == 2 && ! -e "$T/trim.args" ]] || bad+=" not-k2:$rc"
mkk2; rm -rf "$T/tk2/units"; rc=0; td 2026-07-22 - || rc=$?; [[ $rc == 2 ]] || bad+=" no-units:$rc"
mkk2; rc=0; TRIM_LOG_FAIL=1 td 2026-07-22 - --qa || rc=$?; [[ $rc != 0 ]] && ! grep -q "^finalize" "$T/trim.args" || bad+=" log-mismatch:$rc"
[[ -z "$bad" ]] && ok "OF-3 trim-day: the day's list = the day before's verified list + its own migrations (kept in OUT and the assets); per unit trimmed, K2 hashes logged, K2 copy deleted; the per-unit log (k2 lines sorted with LC_ALL=C by path) checked and copied; QA only with --qa; no gh, curl or wget call; refused with no prior list, no or a wrong SHA256SUMS line, a misnamed prior, a unit neither K2 nor K3, or no units; a log mismatch stops it" || no "OF-3 trim-day:$bad"
bad=""
# Ruling 15: a stopped trim resumes from units.k3, units.log.partial and the kept list; the
# K2 hashes are on disk before the K2 copy goes; the trim's own budget stops it resumably.
mkk2; rc=0; TRIM_FAIL_ON=3-4 td 2026-07-22 - || rc=$?
[[ $rc != 0 && -d "$T/tk2/units.k3/1046/1-2" && ! -e "$T/tk2/units/1046/1-2" && -d "$T/tk2/units/1046/3-4" ]] && [[ $(grep -c " 1046/1-2/" "$T/tk2/units.log.partial") == 3 ]] || bad+=" crash-state:$rc"
: > "$T/trim.args"; td 2026-07-22 - || bad+=" resume:$(tail -2 "$T/out.txt")"
[[ $(grep -c "^trim " "$T/trim.args") == 1 && $(grep -c "^trim .*/units.k3/1046/3-4 " "$T/trim.args") == 1 && $(grep -c "^migrations" "$T/trim.args") == 0 && $(grep -c "^k2 " "$T/tk2/units.log") == 6 && ! -e "$T/tk2/units.k3" ]] || bad+=" resumed-once"
mkfx "$T/fxbudget" ARCHIVE_TRIM_BUDGET_S=0; mkk2; rc=0
FAKE_AVAIL=999000000000 DATASET_PARENT="$T/cd-ds" PATH="$TB:$PATH" GITHUB_STEP_SUMMARY="$T/summary.md" bash "$T/fxbudget/research/historical/ci/trim-day.sh" 2026-07-22 "$T/tk2" - "$T/tassets" > "$T/out.txt" 2>&1 || rc=$?
[[ $rc == 1 && -d "$T/tk2/units/1046/1-2" ]] && ! grep -q "^trim " "$T/trim.args" && grep -q "time budget (0 s) spent after 0 units; the day fails (not resumable)" "$T/out.txt" || bad+=" budget:$rc"
grep -q 'sync "$partial"' "$here/trim-day.sh" && [[ $(grep -n 'sync "$partial"' "$here/trim-day.sh" | tail -1 | cut -d: -f1) -lt $(grep -n 'mv "$u" "$u.del"' "$here/trim-day.sh" | cut -d: -f1) ]] || bad+=" fsync-before-delete"
# a delete cut short (the .del copy left) resumes
mkk2; rc=0; TRIM_FAIL_ON=3-4 td 2026-07-22 - || rc=$?; mkdir -p "$T/tk2/units/1046/1-2.del"; echo half > "$T/tk2/units/1046/1-2.del/B.zst"
td 2026-07-22 - && [[ ! -e "$T/tk2/units/1046/1-2.del" && $(grep -c "^k2 " "$T/tk2/units.log") == 6 ]] || bad+=" half-deleted:$(tail -2 "$T/out.txt")"
[[ -z "$bad" ]] && ok "OF-3 ruling 15: a trim stopped after unit 1 leaves its K3 copy and its 3 k2 lines on disk and its K2 copy deleted; the rerun trims only unit 2 with the kept list; the k2 lines are fsynced before each K2 copy is deleted, and a delete cut short (a .del copy left) resumes; a spent ARCHIVE_TRIM_BUDGET_S fails the day (exit 1, ruling 20) before any trim" || no "OF-3 trim resume:$bad"
bad=""
# Ruling 9: a restored day already trimmed is read done: trim-day does nothing, scan-day
# exits 0 with no request; anything short of that is refused.
mkk2; td 2026-07-22 - >/dev/null; rm -rf "$T/tassets"; : > "$T/trim.args"
td 2026-07-22 - && ! grep -q "^trim \|^migrations" "$T/trim.args" && grep -q "already trimmed" "$T/out.txt" && [[ -f "$T/tassets/units-2026-07-22.log" && -f "$T/tassets/list-2026-07-22.txt" ]] || bad+=" trim-noop"
o="$T/of3r"; rm -rf "$o"; cp -r "$T/tk2" "$o"; sed -i 's/"scanner_revision": "rF"/"scanner_revision": "r1"/' "$o"/units/*/*/stats.json
rc=0; SDAY=2026-07-24 SFX=$T/fxk3/research/historical/ci PASSRET=K3 scan "$o" || rc=$?
[[ $rc == 0 && ! -s "$T/calls.log" ]] && grep -q "already read and trimmed (2 K3 units" "$T/out.txt" || bad+=" scan-done:$rc"
rc=0; EXPECT_UNITS=3 SDAY=2026-07-24 SFX=$T/fxk3/research/historical/ci PASSRET=K3 scan "$o" || rc=$?; [[ $rc == 2 && ! -s "$T/calls.log" ]] || bad+=" expect-units:$rc"
rc=0; UNITLOG_FAIL=1 SDAY=2026-07-24 SFX=$T/fxk3/research/historical/ci PASSRET=K3 scan "$o" || rc=$?; [[ $rc == 2 && ! -s "$T/calls.log" ]] || bad+=" check-fails:$rc"
rm -f "$o/units.log"; rc=0; SDAY=2026-07-24 SFX=$T/fxk3/research/historical/ci PASSRET=K3 scan "$o" || rc=$?; [[ $rc == 2 && ! -s "$T/calls.log" ]] || bad+=" no-log:$rc"
[[ -z "$bad" ]] && ok "OF-3 ruling 9: a restored day already trimmed (every unit K3, per-unit log present and checked, expect_units met) is read done: scan-day exits 0 with no request, trim-day does nothing but copy its log and list again; with expect_units unmet, a failing check or no log it is refused" || no "OF-3 restored trimmed day:$bad"
bad=""
# Ruling 11: a day stored at K2 writes its pinned list too.
mkk2; td 2026-07-22 - --list-only && [[ -f "$T/tk2/list-2026-07-22.txt" && -f "$T/tassets/list-2026-07-22.txt" ]] && ! grep "^trim " "$T/trim.args" | grep -qv -- "-out $T/tk2/units.measure/" && [[ -d "$T/tk2/units/1046/1-2" && ! -e "$T/tk2/units.log" && ! -e "$T/tk2/units.k3" ]] || bad+=" list-only"
# OF-4 ruling 2: --list-only also measures the day's PM-01 subset (each unit trimmed into a
# scratch copy that is deleted; the K2 units stay) into ASSET_DIR/pm01-subset-DAY.txt.
[[ $(grep -c "^trim -in $T/tk2/units/1046/[13]-[24] -out $T/tk2/units.measure/1046/[13]-[24] -migration-list $T/tk2/list-2026-07-22.txt$" "$T/trim.args") == 2 && ! -e "$T/tk2/units.measure" ]] || bad+=" measure-trims"
grep -qE '^[1-9][0-9]*$' "$T/tassets/pm01-subset-2026-07-22.txt" 2>/dev/null && ! grep -q '"retention": "K3"' "$T"/tk2/units/1046/*/stats.json || bad+=" subset-file"
mkk2; rc=0; td 2026-07-23 - --list-only || rc=$?; [[ $rc == 2 ]] || bad+=" list-only-no-prior:$rc"
[[ -z "$bad" ]] && ok "OF-3 ruling 11 (OF-4 ruling 2): a day stored at K2 writes list-D.txt (the next day's prior) and pm01-subset-D.txt (its units trimmed only into a deleted scratch copy) and is not trimmed; a day after the first needs the verified prior for it too" || no "OF-3 K2 list:$bad"
bad=""
# Ruling 8: a day after the first is refused before the disk guard, the back-off and any
# scanner call when no verified prior list is present.
for v in "SPL= SPS=" "SPS=" "SPS=$T/badsums"; do
  o="$T/of3p"; rm -rf "$o"; mkdir -p "$o"; now=$(date +%s); echo "$now 600 $((now + 600))" > "$o/archive-429.state"; rc=0
  eval "$v SDAY=2026-07-24 SFX=\$T/fxk3/research/historical/ci PASSRET=K3 FAKE_AVAIL=1 scan \"\$o\"" || rc=$?
  [[ $rc == 2 && ! -s "$T/calls.log" ]] && ! grep -q "disk on" "$T/out.txt" || bad+=" [$v]:$rc"
done
[[ -z "$bad" ]] && ok "OF-3 ruling 8: a day after the first with no prior list, no SHA256SUMS or a wrong one is refused before the disk guard, the back-off and any scanner call" || no "OF-3 prior before reading:$bad"
bad=""
# Round 3, ruling 18: the same prior inputs pass scan-day and trim-day.
mkprior 2026-07-23; o="$T/of3same"; rm -rf "$o"; mkdir -p "$o"; rc=0
SPL=$PRIORL SPS=$PRIORS SDAY=2026-07-23 SFX=$T/fxk3/research/historical/ci PASSRET=K3 scan "$o" || rc=$?
[[ $rc == 0 && $(calls) == "scan " ]] || bad+=" scan:$rc"
mkk2; TPS=$PRIORS td 2026-07-23 "$PRIORL" && [[ -f "$T/tassets/units-2026-07-23.log" ]] || bad+=" trim:$(tail -1 "$T/out.txt")"
mkk2; TPS=$PRIORS td 2026-07-23 "$PRIORL" --list-only && [[ -f "$T/tassets/list-2026-07-23.txt" ]] || bad+=" list-only"
[[ -z "$bad" ]] && ok "OF-3 ruling 18: one prior list and SHA256SUMS pass both scan-day (before any read) and trim-day (trim and --list-only)" || no "OF-3 same prior inputs:$bad"
bad=""
# Ruling 21: a torn append is dropped and the unit's lines rewritten before its K2 copy goes.
mkk2; rc=0; TRIM_FAIL_ON=3-4 td 2026-07-22 - || rc=$?
(cd "$T/tk2/units" && sha256sum -- 1046/3-4/B.zst 1046/3-4/a.zst) | sed 's/^\([0-9a-f]\{64\}\)  /k2 \1 /' >> "$T/tk2/units.log.partial"
printf 'k2 12ab' >> "$T/tk2/units.log.partial"
td 2026-07-22 - || bad+=" resume:$(tail -1 "$T/out.txt")"
[[ $(grep -c "^k2 " "$T/tk2/units.log") == 6 ]] && ! grep -q "12ab" "$T/tk2/units.log" && grep -qx "k2 $(h raw3-4) 1046/3-4/raw_canonical.jsonl.zst" "$T/tk2/units.log" || bad+=" torn:$(grep -c "^k2 " "$T/tk2/units.log" 2>/dev/null)"
[[ -z "$bad" ]] && ok "OF-3 ruling 21: after a torn append (2 of a unit's 3 k2 lines and a cut line), the resumed trim drops the cut line, rewrites the unit's lines from a temp file and deletes the K2 copy only with one line per file" || no "OF-3 torn k2 append:$bad"
bad=""
# Ruling 22: a restored trimmed day's list must be the one its units were trimmed with.
mkk2; td 2026-07-22 - >/dev/null; rm -rf "$T/tassets"; : > "$T/trim.args"
echo "other 1 2" > "$T/tk2/list-2026-07-22.txt"; rc=0; td 2026-07-22 - || rc=$?
[[ $rc == 2 && ! -e "$T/tassets/list-2026-07-22.txt" ]] && grep -q "was not trimmed with" "$T/out.txt" || bad+=" other-list:$rc"
[[ -z "$bad" ]] && ok "OF-3 ruling 22: a restored trimmed day whose list sha256 is not every unit's migration_list_sha256 is refused before anything is copied" || no "OF-3 restored list check:$bad"
bad=""
# Ruling 14: between units, free space below the largest unit + the trim headroom stops the scan (exit 75).
mkfx "$T/fxdisk" ARCHIVE_TRIM_HEADROOM_BYTES=60000000000 ARCHIVE_RETENTION=K3
o="$T/of3w"; rm -rf "$o"; mkdir -p "$o"; rc=0; t0=$(date +%s)
SLOW=1 ARCHIVE_DISK_POLL_S=1 FAKE_AVAIL=55000000000 SDAY=2026-07-24 SFX=$T/fxdisk/research/historical/ci PASSRET=K3 scan "$o" || rc=$?
[[ $rc == 1 && $(calls) == "scan interrupted " ]] && (( $(date +%s) - t0 < 15 )) && grep -q "free disk fell to 55000000000 bytes, below the largest unit (0) + the trim headroom .*the day fails, not resumable" "$T/out.txt" || bad+=" stop:$rc:$(calls)"
o="$T/of3w2"; rm -rf "$o"; mkdir -p "$o"; rc=0
ARCHIVE_DISK_POLL_S=1 FAKE_AVAIL=55000000000 SDAY=2026-07-24 SFX=$T/fxk3/research/historical/ci PASSRET=K3 scan "$o" || rc=$?
[[ $rc == 0 && $(calls) == "scan " ]] || bad+=" room:$rc"
[[ -z "$bad" ]] && ok "OF-3 ruling 14: while the K2 day is read, free space below the largest unit so far + ARCHIVE_TRIM_HEADROOM_BYTES interrupts the scan between units and fails the day (exit 1, ruling 20); with room it scans on" || no "OF-3 disk watch:$bad"
bad=""
python3 - "$here/../../../.github/workflows/data-scan.yml" <<'PY' || bad+=" workflow-trim"
import sys, yaml
steps = yaml.safe_load(open(sys.argv[1]))["jobs"]["scan"]["steps"]
ids = [s.get("id") or s.get("name") for s in steps]
assert ids.index("qatime") < ids.index("trim") == ids.index("guardqa") - 1 < ids.index("qa"), ids
t = steps[ids.index("trim")]
assert t["if"] == "steps.published.outputs.complete != 'true' && inputs.source != 'helius'" and "github.token" not in str(t) and "secrets." not in str(t), t
assert 'archive-guard.sh local "$DAY"' in t["run"], t
# OF-3 ruling 18: both trim calls take the prior list scan-day checks (ARCHIVE_PRIOR_LIST, "-" for the first day)
assert t["run"].count('trim-day.sh "$DAY" "$RUNNER_TEMP/work/data" "${ARCHIVE_PRIOR_LIST:--}" "$RUNNER_TEMP/work/assets"') == 2 and " - " not in t["run"], t
# ruling 23 (as wired by OF-5): one source, the prior step's outputs, set only on the scan
# and trim steps; no job or workflow env sets either
job = yaml.safe_load(open(sys.argv[1]))["jobs"]["scan"]
assert not set(job.get("env") or {}) & {"ARCHIVE_PRIOR_LIST", "ARCHIVE_PRIOR_SUMS"}, job.get("env")
for st in steps:
    e = st.get("env") or {}
    if set(e) & {"ARCHIVE_PRIOR_LIST", "ARCHIVE_PRIOR_SUMS"}:
        assert st.get("id") in ("scan", "trim") and e["ARCHIVE_PRIOR_LIST"] == "${{ steps.prior.outputs.list }}" and e["ARCHIVE_PRIOR_SUMS"] == "${{ steps.prior.outputs.sums }}", st
wf = yaml.safe_load(open(sys.argv[1]))
for jn, j in wf["jobs"].items():
    assert not set(j.get("env") or {}) & {"ARCHIVE_PRIOR_LIST", "ARCHIVE_PRIOR_SUMS"}, jn
assert not set(wf.get("env") or {}) & {"ARCHIVE_PRIOR_LIST", "ARCHIVE_PRIOR_SUMS"}
# ruling 20: a trim out of budget is not resumable
assert "resumable" not in t["run"] and all("steps.trim.outputs.resumable" not in str(st.get("if", "")) for st in steps), t
PY
[[ -z "$bad" ]] && ok "OF-3 data-scan: the trim step runs after the scan and right before the QA guard, with no token, behind the local guard; both trim calls take \${ARCHIVE_PRIOR_LIST:--} (rulings 18; OF-5 hands both the stored prior list); a trim out of budget is never chained (ruling 20); ARCHIVE_PRIOR_LIST and ARCHIVE_PRIOR_SUMS are declared once for the scan job and set by no step (ruling 23)" || no "OF-3 workflow trim:$bad"
bad=""

# ---- OF-2 round 2 (docs/reviews/OF2.md rulings 1-10) ----
gdreset; bad=""; now=$(date -u +%s)
attemptfile() { printf '{"status": "completed", "conclusion": "%s", "updated_at": "%s"}\n' "$3" "$(iso $(( $(date -u +%s) - $4 * 60 )))" > "$GD/attempt-$1-$2.json"; }
# 1. Re-runs. A re-run of archive-check (attempt 2) never probes; the guard's full and
# attest refuse attempt 2; a re-run's earlier failed attempt still counts.
rc=0; ac env AC_STATUS=206 GITHUB_RUN_ATTEMPT=2 || rc=$?
[[ $rc == 1 && ! -e "$A/curl.calls" && ! -e "$GD/dispatch.log" && ! -e "$GD/gh.log" ]] && grep -q "run attempt '2' is not 1" "$A/summary.md" || bad+=" check-attempt2:$rc"
for m in full attest; do
  rc=0; GD="$GD" GH_BIN="$GD/bin/gh" GH_REPO=o/r DATA_REPO=o/data DATA_STORE_TOKEN=tok GH_TOKEN=x GITHUB_REF=refs/heads/main GITHUB_RUN_ID=700 GITHUB_RUN_ATTEMPT=2 \
    bash "$FX/archive-guard.sh" $m 2026-07-22 $([[ $m == attest ]] && echo "$T/attest2") > "$T/gout.txt" 2>&1 || rc=$?
  [[ $rc == 2 && ! -e "$T/attest2/2026-07-22" ]] && grep -q "run attempt '2' is not 1" "$T/gout.txt" || bad+=" guard-$m-attempt2:$rc"
done
# A failed check re-run green: attempt 1's probe failure (250 min ago) counts with two more.
{ ATTEMPT=2 acrun 531 success 240; acrun 532 failure 420 notserved; acrun 533 failure 360 notserved; } | acjson
attemptfile 531 1 failure 250; jobsfile 531 "Archive probe (a failure unless served)=failure"; mv "$GD/jobs-531.json" "$GD/jobs-531-1.json"
echo "[{\"title\": \"archive-backoff\", \"message\": \"end=$(( $(date -u +%s) - 250 * 60 + 10800 ))\"}]" > "$GD/ann-5310.json"
attemptfile 531 2 success 240; echo '{"jobs": [{"name": "check", "conclusion": "success", "steps": [{"name": "Holds", "conclusion": "success"}]}]}' > "$GD/jobs-531-2.json"
ACFX=$T/fxr8/research/historical/ci ac env AC_STATUS=206
[[ ! -e "$A/curl.calls" ]] && grep -q "held (3): the chain is stopped: 3 failures" "$A/summary.md" || bad+=" rerun-check:$(cat "$A/summary.md")"
# Failed batch #3 re-run green (a Publish success in attempt 2): still 3 failures.
rm -f "$GD"/jobs-* "$GD"/attempt-* "$GD/ac.json"
{ dsrun 351 "data-scan scan source=archive" failure 500 420 "scan (2026-07-22)=failure,continue=failure"
  dsrun 352 "data-scan scan source=archive" failure 400 360 "scan (2026-07-22)=failure,continue=failure"
  ATTEMPT=2 dsrun 353 "data-scan scan source=archive" success 320 240; } | dsjson
attemptfile 353 1 failure 300; jobsfile 353 "scan (2026-07-22)=failure,continue=failure"; mv "$GD/jobs-353.json" "$GD/jobs-353-1.json"
attemptfile 353 2 success 240; jobsfile 353 "scan (2026-07-22)=success,Store this day=success"; mv "$GD/jobs-353.json" "$GD/jobs-353-2.json"
ACFX=$T/fxr8/research/historical/ci ac env AC_STATUS=206
[[ ! -e "$A/curl.calls" ]] && grep -q "held (3): the chain is stopped: 3 failures" "$A/summary.md" || bad+=" rerun-batch:$(cat "$A/summary.md")"
FXG=$T/fxr8/research/historical/ci guard full 2026-07-22; rc=$?
[[ $rc == 2 ]] && grep -q "chain is stopped" "$T/gout.txt" || bad+=" rerun-batch-plan:$rc"
[[ -z "$bad" ]] && ok "OF-2 r2 ruling 1: a re-run (attempt 2) of archive-check, or of the guard's full or attest, refuses with no request; a failed check re-run green and failed batch #3 re-run green still count their first attempt's failure (3 failures: no request, and a manual dispatch refused)" || no "OF-2 r2 re-runs:$bad"
bad=""; gdreset
# 2. A manual dispatch gets every hold of a check: (a) out of order, (b) done, (c) within
# 3 h of a 403/503 (a blocked batch), (d) within 60 min of the last lane run.
rc=0; guard full 2026-07-23 || rc=$?
[[ $rc == 2 ]] && grep -q "2026-07-23 is not the oldest allow-listed day not read done (2026-07-22)" "$T/gout.txt" || bad+=" a:$rc"
echo 2026-07-22 > "$GD/published"; rc=0; guard full 2026-07-22 || rc=$?
[[ $rc == 2 ]] && grep -q "2026-07-22 is not the oldest allow-listed day not read done (2026-07-23)" "$T/gout.txt" || bad+=" b:$rc"
rm -f "$GD/published"
dsrun 361 "data-scan scan source=archive" failure 200 120 "scan (2026-07-22)=failure,continue=failure" | dsjson
rc=0; guard full 2026-07-22 || rc=$?
[[ $rc == 2 ]] && grep -q "back-off: nothing goes out before" "$T/gout.txt" || bad+=" c:$rc"
dsrun 362 "data-scan scan source=archive" success 200 30 "scan (2026-07-21)=success" | dsjson
rc=0; guard full 2026-07-22 || rc=$?
[[ $rc == 2 ]] && grep -q "less than 60 min ago" "$T/gout.txt" || bad+=" d:$rc"
dsrun 363 "data-scan scan source=archive" failure 200 5 "scan (2026-07-22)=failure,continue=success" | dsjson
guard full 2026-07-22 || bad+=" chained-restart"
dsrun 364 "data-scan scan source=archive" failure 200 5 "scan (2026-07-21)=failure,continue=success" | dsjson
rc=0; guard full 2026-07-22 || rc=$?; [[ $rc == 2 ]] || bad+=" other-day-restart:$rc"
rm -f "$GD/ds.json" "$GD"/jobs-*
guard full 2026-07-22 || bad+=" control"
[[ -z "$bad" ]] && ok "OF-2 r2 ruling 2: a manual dispatch is refused at the plan job (a) out of order, (b) for a day read done, (c) within 3 h of a blocked batch, (d) within 60 min of the last lane run; only this day's own chained restart passes the 60-min gap" || no "OF-2 r2 manual dispatch:$bad"
bad=""
# 3. A no-op success (the day was already published: no Publish step) does not reset.
{ dsrun 371 "data-scan scan source=archive" failure 500 420 "scan (2026-07-22)=failure,continue=failure"
  dsrun 372 "data-scan scan source=archive" failure 400 360 "scan (2026-07-22)=failure,continue=failure"
  dsrun 373 "data-scan scan source=archive" success 340 330 "scan (2026-07-22)=success,Store this day=skipped"
  dsrun 374 "data-scan scan source=archive" failure 320 300 "scan (2026-07-22)=failure,continue=failure"; } | dsjson
ACFX=$T/fxr8/research/historical/ci ac env AC_STATUS=206
[[ ! -e "$A/curl.calls" ]] && grep -q "held (3): the chain is stopped: 3 failures" "$A/summary.md" &&
  ok "OF-2 r2 ruling 3: a no-op success after 2 failures (no day stored) does not reset the count: a third failure stops the chain" || no "OF-2 r2 no-op success: $(cat "$A/summary.md")"
gdreset
# 4. Default branch only; failures from every branch count; markers only from default-branch runs.
rc=0; ac env AC_STATUS=206 GITHUB_REF=refs/heads/feature || rc=$?
[[ ! -e "$A/curl.calls" ]] && grep -q "held (1): ref 'refs/heads/feature' is not the default branch" "$A/summary.md" || bad+=" check-branch"
rc=0; GD="$GD" GH_BIN="$GD/bin/gh" GH_REPO=o/r DATA_REPO=o/data DATA_STORE_TOKEN=tok GH_TOKEN=x GITHUB_REF=refs/heads/feature GITHUB_RUN_ID=700 GITHUB_RUN_ATTEMPT=1 \
  bash "$FX/archive-guard.sh" full 2026-07-22 > "$T/gout.txt" 2>&1 || rc=$?
[[ $rc == 2 ]] && grep -q "is not the default branch" "$T/gout.txt" || bad+=" guard-branch:$rc"
BRANCH=feature acrun 541 failure 120 notserved | acjson
ac env AC_STATUS=206
[[ ! -e "$A/curl.calls" ]] && grep -q "held (2): back-off" "$A/summary.md" || bad+=" other-branch-failure"
{ BRANCH=feature acrun 542 success 2; } | acjson
# (round 4, ruling 29: an archive check from another branch since the re-arm stops the
# chain, so the marker is checked against a re-arm 1 min ago)
mkfx "$T/fxr1m" ARCHIVE_REARM_AT="$(iso $(( $(date -u +%s) - 60 )))"
mk "$(mkey 2 542)@refs/heads/main"; KEEPCACHE=1 ACFX=$T/fxr1m/research/historical/ci ac env AC_STATUS=206
[[ $(wc -l < "$A/curl.calls" 2>/dev/null) == 1 ]] || bad+=" other-branch-marker"
[[ -z "$bad" ]] && ok "OF-2 r2 ruling 4: archive-check and the guard refuse off the default branch; a non-served check on another branch still counts (back-off); a marker from another branch's run is ignored" || no "OF-2 r2 branches:$bad"
bad=""; gdreset
# 6. A probe cancelled or timed out counts; a holds-only failure does not.
for c in cancelled timed_out; do
  PROBE=$c acrun 551 "$c" 120 notserved | acjson
  ac env AC_STATUS=206
  [[ ! -e "$A/curl.calls" ]] && grep -q "held (2): back-off" "$A/summary.md" || bad+=" $c"
done
acrun 552 failure 120 | acjson; echo '{"jobs": [{"name": "check", "conclusion": "failure", "steps": [{"name": "Holds", "conclusion": "failure"}, {"name": "Archive probe (a failure unless served)", "conclusion": "skipped"}]}]}' > "$GD/jobs-552.json"
ac env AC_STATUS=206; [[ $(wc -l < "$A/curl.calls" 2>/dev/null) == 1 ]] || bad+=" holds-only"
rm -f "$GD/ac.json" "$GD"/jobs-*
ac env AC_STATUS=429
[[ $ACRC == 1 ]] && grep -q "probe sent for 2026-07-22" "$A/out.txt" || bad+=" probe-exit:$ACRC"
[[ -z "$bad" ]] && ok "OF-2 r2 ruling 6: the probe step logs the probe-sent mark before the request and fails unless served; a probe cancelled or timed out counts as a failure; a failed holds step with the probe skipped does not" || no "OF-2 r2 probe mark:$bad"
bad=""; gdreset
# 8. The pass binds retention, run id and attempt.
o="$T/r2p"; for v in "2026-07-22 K3" "2026-07-22 K2 x 701 1" "2026-07-22 K2 x 700 2"; do
  rm -rf "$o" "$GP"; mkdir -p "$o" "$GP"; set -- $v; echo "$1 $2 $(date -u +%s) ${4:-700} ${5:-1}" > "$GP/2026-07-22"
  rc=0; ARCHIVE_GO="$T/archive10.go" ARCHIVE_GUARD_DIR="$GP" PATH="$S:$PATH" GITHUB_STEP_SUMMARY="$T/summary.md" bash "$FX/scan-day.sh" 2026-07-22 "$o" 40 300 > "$T/out.txt" 2>&1 || rc=$?
  [[ $rc == 2 ]] && grep -q "for another retention, run or attempt" "$T/out.txt" || bad+=" [$v]:$rc"
done
rm -rf "$GP"; guard attest 2026-07-22 "$GP"; read -r d r t id at fl < "$GP/2026-07-22"; [[ "$d $r $id $at $fl" == "2026-07-22 K2 700 1 0" ]] || bad+=" attest-format"
[[ -z "$bad" ]] && ok "OF-2 r2 ruling 8: the guard pass carries retention, run id and attempt; scan-day refuses a pass for another retention, run or attempt" || no "OF-2 r2 pass binding:$bad"
bad=""; gdreset
# 9. Not armed while days would still be stored in this public repository.
# (OF-4 made the real files private, so the public forms are rebuilt here as fixtures.)
for v in day vol art write; do
  mkfx "$T/fxpub$v"; c="$T/fxpub$v/research/historical/ci" w="$T/fxpub$v/.github/workflows/data-scan.yml"
  case $v in
    day) sed 's/--repo "\$DATA_REPO"/--repo "$GITHUB_REPOSITORY"/' "$here/publish-day.sh" > "$c/publish-day.sh" ;;
    vol) sed 's/--repo "\$DATA_REPO"/--repo "$GITHUB_REPOSITORY"/' "$here/publish-volume.sh" > "$c/publish-volume.sh" ;;
    art) python3 - "$w" <<'PY'
import sys
p = sys.argv[1]; s = open(p).read(); i = s.index("      - name: Store this day\n")
s = s[:i] + "      - uses: actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02 # v4.6.2\n        with:\n          name: day-${{ matrix.day }}\n          path: ${{ runner.temp }}/work/assets\n" + s[i:]
open(p, "w").write(s)
PY
    ;;
    write) sed -i 's/      contents: read # OF-4: nothing is written to this repository; the day goes to the private store/      contents: write/' "$w"; grep -q '^      contents: write$' "$w" || bad+=" fixture-write" ;;
  esac
  ACFX=$c ac env AC_STATUS=206
  [[ ! -e "$A/curl.calls" ]] && grep -qE "held \(1\): the archive chain is not armed: .*(publish-day.sh|publish-volume.sh|contents: write|artifact other than|uploads an artifact)" "$A/summary.md" || bad+=" check-$v"
  rc=0; FXG=$c guard full 2026-07-22 || rc=$?; [[ $rc == 2 ]] || bad+=" plan-$v:$rc"
done
[[ -z "$bad" ]] && ok "OF-2 r2 ruling 9: armed, the chain still refuses (archive-check and a manual dispatch) while publish-day.sh (and its skip check) or publish-volume.sh release to this repository, or data-scan.yml uploads the day-DAY artifact or grants contents: write" || no "OF-2 r2 public storage:$bad"
bad=""; gdreset
# 10. Retry-After: the probe records it; hold 2 and the guard wait for max(3 h, the end).
rc=0; ac env AC_STATUS=429 AC_RA=30000 || rc=$?
end=$(sed -n 's/^backoff_end=//p' "$A/output"); n=$(date -u +%s)
(( ${end:-0} >= n + 29990 && ${end:-0} <= n + 30000 )) && grep -q "^archive-backoff-$end-900" <(jq -r '.actions_caches[].key' "$GD/caches.json") || bad+=" record:$end"
ac env AC_STATUS=429 AC_RA="$(date -u -d "@$(( n + 18000 ))" '+%a, %d %b %Y %H:%M:%S GMT')"
end2=$(sed -n 's/^backoff_end=//p' "$A/output"); (( ${end2:-0} >= n + 17990 && ${end2:-0} <= n + 18010 )) || bad+=" http-date:$end2"
addcache "archive-backoff-$(( n + 20000 ))-9" refs/heads/main
acrun 561 failure 200 notserved | acjson
KEEPCACHE=1 ac env AC_STATUS=206
[[ ! -e "$A/curl.calls" ]] && grep -q "held (2): back-off: nothing goes out before $(iso $(( n + 20000 )))" "$A/summary.md" || bad+=" hold-ra:$(cat "$A/summary.md")"
rc=0; guard full 2026-07-22 || rc=$?; [[ $rc == 2 ]] && grep -q "back-off" "$T/gout.txt" || bad+=" plan-ra:$rc"
addcache "archive-backoff-$(( n - 60 ))-9" refs/heads/other
python3 - "$GD/caches.json" <<'PY'
import json, sys
p = sys.argv[1]; c = json.load(open(p)); c["actions_caches"] = [x for x in c["actions_caches"] if x["ref"] != "refs/heads/main"]; json.dump(c, open(p, "w"))
PY
KEEPCACHE=1 ac env AC_STATUS=206; [[ $(wc -l < "$A/curl.calls" 2>/dev/null) == 1 ]] || bad+=" ra-over"
[[ -z "$bad" ]] && ok "OF-2 r2 ruling 10: a probe's Retry-After (seconds or an HTTP date) is recorded as cache key archive-backoff-<end>; with a recorded end 5.5 h out, a non-served check 3 h 20 min ago still holds archive-check and a manual dispatch; once only other branches' ends remain, the check proceeds" || no "OF-2 r2 Retry-After:$bad"
bad=""; gdreset
python3 - "$here/../../../.github/workflows/data-scan.yml" <<'PY' || bad+=" scan-records-end"
import sys, yaml
steps = yaml.safe_load(open(sys.argv[1]))["jobs"]["scan"]["steps"]
s = next(st for st in steps if st.get("name") == "Record the back-off end for archive-check")
assert s["uses"].startswith("actions/cache/save@") and s["with"]["key"].startswith("archive-backoff-${{ steps.backoff.outputs.end }}-"), s
assert "steps.backoff.outputs.end != ''" in s["if"] and "inputs.source != 'helius'" in s["if"], s
b = next(st for st in steps if st.get("id") == "backoff")
assert 'echo "end=$end" >> "$GITHUB_OUTPUT"' in b["run"] and "::warning" not in b["run"], b
# round 4, ruling 25: the annotation is the one annotation of its own step
names = [st.get("id") or st.get("name") for st in steps]
a = steps[names.index("Record the back-off annotation")]
assert names.index("Record the back-off annotation") == names.index("backoff") + 1, names
assert "steps.backoff.outputs.end != ''" in a["if"] and "inputs.source != 'helius'" in a["if"] and a["if"].startswith("always()"), a
assert a["env"] == {"END": "${{ steps.backoff.outputs.end }}"} and a["run"].strip() == 'if [[ "$END" =~ ^[0-9]{9,11}$ ]]; then echo "::warning title=archive-backoff::end=$END"; fi', a
for st in steps:
    if "archive-guard.sh\" attest" in str(st) or "archive-guard.sh\" full" in str(st):
        assert 'GITHUB_REF="$GITHUB_REF" GITHUB_RUN_ID="$GITHUB_RUN_ID" GITHUB_RUN_ATTEMPT="$GITHUB_RUN_ATTEMPT"' in st["run"], st
PY
[[ -z "$bad" ]] && ok "OF-2 r2 ruling 10: the scan saves its back-off end as archive-backoff-<end> (and, round 4 ruling 25, its annotation in its own step); the guard steps get the ref, run id and attempt in their clean shell" || no "OF-2 r2 scan back-off:$bad"
bad=""

# ---- OF-2 round 2 ruling 11: the real scanner binary takes -retention (OF-3) ----
bad=""
if (cd "$here/../scanner" && go build -o "$T/zeroed-scan-real" .) > "$T/gobuild.txt" 2>&1; then
  for m in run unit; do
    out=$("$T/zeroed-scan-real" $m -retention K9 -out "$T/zsreal" 2>&1) && bad+=" $m-K9-accepted"
    [[ "$out" == *"refused: -retention must be K2 or K3"* && "$out" != *"flag provided but not defined"* ]] || bad+=" $m-K9:$out"
    out=$("$T/zeroed-scan-real" $m -retention K3 -out "$T/zsreal" 2>&1) && bad+=" $m-K3-nolist-accepted"
    [[ "$out" == *"refused: -retention K3 needs the pinned -migration-list"* ]] || bad+=" $m-K3:$out"
  done
  [[ ! -e "$T/zsreal/cache" ]] || bad+=" touched-cache"
else bad+=" build:$(tail -3 "$T/gobuild.txt")"; fi
[[ -z "$bad" ]] && ok "OF-2 r2 ruling 11: the real scanner binary (run and unit) defines -retention and refuses K9, and K3 without the pinned list, before opening anything" || no "OF-2 r2 real -retention:$bad"

# ---- OF-2 round 3 (docs/reviews/OF2.md rulings 12-20) ----
gdreset; bad=""; now=$(date -u +%s)
# 12 (a): S only from a default-branch run whose plan job's "Archive guard" step passed.
{ dsrun 601 "data-scan scan source=archive" failure 500 420 "scan (2026-07-22)=failure,continue=failure"
  dsrun 602 "data-scan scan source=archive" failure 400 360 "scan (2026-07-22)=failure,continue=failure"
  dsrun 603 "data-scan scan source=archive" success 340 330 "scan (2026-07-22)=success,Store this day=success"
  dsrun 604 "data-scan scan source=archive" failure 320 300 "scan (2026-07-22)=failure,continue=failure"; } | dsjson
ACFX=$T/fxr8/research/historical/ci ac env AC_STATUS=206
[[ ! -e "$A/curl.calls" ]] && grep -q "held (3): the chain is stopped: 3 failures" "$A/summary.md" || bad+=" s-without-guard"
jobsfile 603 "Archive guard=success,scan (2026-07-22)=success,Store this day=success"
ACFX=$T/fxr8/research/historical/ci ac env AC_STATUS=206
[[ $(wc -l < "$A/curl.calls" 2>/dev/null) == 1 ]] || bad+=" s-with-guard:$(cat "$A/summary.md")"
[[ -z "$bad" ]] && ok "OF-2 r3 ruling 12 (a): a stored day counts as a success only when the run's plan job passed the Archive guard: without it 2 failures + that run + 1 failure stop the chain; with it the count resets" || no "OF-2 r3 success needs the guard:$bad"
bad=""; gdreset
# 12 (b): a non-Helius data-scan run from another branch since ARCHIVE_REARM_AT stops the chain.
python3 - "$GD/ds.json" "$(iso $(( now - 7200 )))" <<'PY'
import json, sys
json.dump([{"databaseId": 611, "status": "completed", "conclusion": "success", "createdAt": sys.argv[2], "updatedAt": sys.argv[2], "attempt": 1, "headBranch": "old-branch", "displayTitle": "data-scan"}], open(sys.argv[1], "w"))
PY
ac env AC_STATUS=206
[[ ! -e "$A/curl.calls" ]] && grep -q "held (3): the chain is stopped: 1 run(s) since ARCHIVE_REARM_AT may have read the archive unguarded" "$A/summary.md" || bad+=" check"
rc=0; guard full 2026-07-22 || rc=$?; [[ $rc == 2 ]] && grep -q "may have read the archive unguarded" "$T/gout.txt" || bad+=" plan:$rc"
mkfx "$T/fxr1h" ARCHIVE_REARM_AT="$(iso $(( now - 3600 )))"
ACFX=$T/fxr1h/research/historical/ci ac env AC_STATUS=206; [[ $(wc -l < "$A/curl.calls" 2>/dev/null) == 1 ]] || bad+=" before-rearm"
sed -i 's/"displayTitle": "data-scan"/"displayTitle": "data-scan scan source=helius"/' "$GD/ds.json"
ac env AC_STATUS=206; [[ $(wc -l < "$A/curl.calls" 2>/dev/null) == 1 ]] || bad+=" helius-other-branch"
[[ -z "$bad" ]] && ok "OF-2 r3 ruling 12 (b): a non-Helius data-scan run from another branch since ARCHIVE_REARM_AT stops the chain (archive-check and a manual dispatch); one before a later re-arm, or a Helius run, does not" || no "OF-2 r3 foreign branch:$bad"
bad=""; gdreset
# 12 (c): the read-only list of branches whose data-scan.yml reads the archive unguarded.
echo '[{"name": "main"}, {"name": "old"}, {"name": "helius-only"}, {"name": "nofile"}]' > "$GD/branches.json"
printf 'jobs:\n  scan:\n    run: research/historical/ci/archive-guard.sh attest\n    run2: research/historical/ci/scan-day.sh\n' > "$GD/wf-main.yml"
printf 'jobs:\n  scan:\n    run: research/historical/ci/scan-day.sh "$DAY"\n' > "$GD/wf-old.yml"
printf 'jobs:\n  scan:\n    run: research/historical/ci/rpc-day.sh "$DAY"\n' > "$GD/wf-helius-only.yml"
rc=0; out=$(GD="$GD" GH_BIN="$GD/bin/gh" GH_REPO=o/r bash "$here/unguarded-refs.sh" 2>"$T/ur.err") || rc=$?
[[ $rc == 0 && "$out" == old ]] && grep -q "1 of 4 branches and tags" "$T/ur.err" || bad+=" list:$rc:$out"
! grep -vE '^gh api (--paginate )?repos/o/r/(branches|tags|contents/)' "$GD/gh.log" | grep -q . || bad+=" non-read-call"
rc=0; GD="$GD" GH_BIN="$GD/bin/gh" GH_REPO=o/r GD_CONTENT_FAIL=1 bash "$here/unguarded-refs.sh" >/dev/null 2>&1 || rc=$?; [[ $rc == 1 ]] || bad+=" error:$rc"
[[ -z "$bad" ]] && ok "OF-2 r3 ruling 12 (c): unguarded-refs.sh lists the branches whose data-scan.yml runs the scan without archive-guard.sh (not the default branch, a Helius-only file or a branch without the file), with read calls only; an API error fails it" || no "OF-2 r3 unguarded refs:$bad"
bad=""; gdreset
# 13: capability, not spelling: every bypass form refuses to arm.
byp() { mkfx "$T/fxb"; c="$T/fxb/research/historical/ci"; w="$T/fxb/.github/workflows/data-scan.yml"; eval "$1"
  ACFX=$c ac env AC_STATUS=206; [[ ! -e "$A/curl.calls" ]] && grep -q "held (1): the archive chain is not armed" "$A/summary.md" || bad+=" check[$2]"
  rc=0; FXG=$c guard full 2026-07-22 || rc=$?; [[ $rc == 2 ]] || bad+=" plan[$2]:$rc"; }
byp 'echo '"'"'"$GH" release create x --repo "${GITHUB_REPOSITORY}"'"'"' >> "$c/publish-day.sh"' braces
byp 'echo '"'"'"$GH" release upload x --repo "$DATA_REPO" -R o/r'"'"' >> "$c/publish-volume.sh"' minus-R
byp 'echo '"'"'GH_REPO=o/r gh release create x --repo "$DATA_REPO"'"'"' >> "$c/publish-day.sh"' gh-repo-env
byp 'echo '"'"'gh release create x'"'"' >> "$c/publish-day.sh"' no-repo
byp 'printf "#!/usr/bin/env bash\ngh release view x \\\\\n  --repo o/public\n" > "$c/new-pub.sh"' new-script-continued
byp 'echo '"'"'gh api "repos/$GITHUB_REPOSITORY/releases" -f tag_name=x'"'"' >> "$c/publish-day.sh"' api-releases
byp 'sed "s/--repo \"\\\$DATA_REPO\"/--repo \"\$GITHUB_REPOSITORY\"/" "$here/assemble.sh" > "$c/assemble.sh"' assemble-public
byp 'sed -i "0,/name: resume-\\\${{ matrix.day }}/s//name: day2-\${{ matrix.day }}/" "$w"' renamed-artifact
byp 'python3 -c "import sys; p=sys.argv[1]; s=open(p).read(); i=s.index(\"  volume:\"); j=s.index(\"permissions:\", i); open(p,\"w\").write(s[:j] + \"permissions:\\n      contents: write\\n    \" + s[j:])" "$w"' volume-write
mkfx "$T/fxb"; ACFX=$T/fxb/research/historical/ci ac env AC_STATUS=206; [[ $(wc -l < "$A/curl.calls" 2>/dev/null) == 1 ]] || bad+=" control"
[[ -z "$bad" ]] && ok "OF-2 r3 ruling 13: arming refuses on the capability: \${GITHUB_REPOSITORY}, -R, GH_REPO=, a release call with no --repo, a new script (continued line), a releases API path, assemble.sh releasing to this repository, a renamed upload artifact and contents: write in the volume job; the private-store fixture arms" || no "OF-2 r3 capability:$bad"
bad=""; gdreset
# 14: the durable back-off record, a check-run annotation of each counted failure.
acrun 621 failure 240 notserved | acjson
echo "[{\"title\": \"archive-backoff\", \"message\": \"end=$(( now + 4 * 3600 ))\"}]" > "$GD/ann-6210.json"
ac env AC_STATUS=206
[[ ! -e "$A/curl.calls" ]] && grep -q "held (2): back-off: nothing goes out before $(iso $(( now + 4 * 3600 )))" "$A/summary.md" || bad+=" ann-end:$(cat "$A/summary.md")"
rc=0; guard full 2026-07-22 || rc=$?; [[ $rc == 2 ]] && grep -q "back-off" "$T/gout.txt" || bad+=" plan:$rc"
ac env AC_STATUS=206 GD_ANN_FAIL=1
[[ ! -e "$A/curl.calls" ]] && grep -q "held (2): the failures' archive-backoff annotations cannot be read" "$A/summary.md" || bad+=" unreadable"
# round 4, ruling 25: a probe failure with no annotation reads as end=hold
rm -f "$GD/ann-6210.json"; ac env AC_STATUS=206
[[ ! -e "$A/curl.calls" ]] && grep -q "or a probe failure has no archive-backoff annotation" "$A/summary.md" || bad+=" no-annotation-holds"
# a scan failure with no annotation leaves the 3 h rule
gdreset; dsrun 622 "data-scan scan source=archive" failure 250 240 "scan (2026-07-22)=failure,continue=failure" | dsjson
ac env AC_STATUS=206; [[ $(wc -l < "$A/curl.calls" 2>/dev/null) == 1 ]] || bad+=" scan-no-annotation-3h-only"
gdreset; ac env AC_STATUS=429 AC_RA=30000
grep -qx "backoff_annotation=$(sed -n 's/^backoff_end=//p' "$A/output")" "$A/output" && ! grep -q "::warning" "$A/out.txt" || bad+=" probe-annotates"
[[ -z "$bad" ]] && ok "OF-2 r3 ruling 14: a counted failure's archive-backoff annotation (end=<unix>) holds archive-check and a manual dispatch past 3 h; an unreadable annotation holds (fail closed); a probe failure with none holds (round 4, ruling 25), a scan failure with none leaves the 3 h rule; the probe hands the annotation to its own step" || no "OF-2 r3 annotations:$bad"
bad=""; gdreset
# 15: the continue step refuses a re-run.
dsrun 631 "data-scan scan source=archive" failure 300 290 "scan (2026-07-21)=failure,continue=success" | dsjson
rc=0; cont CHAIN=0 SOURCE=archive GITHUB_RUN_ATTEMPT=2 || rc=$?
[[ $rc == 1 && ! -e "$GD/dispatch.log" ]] && grep -q "a re-run never chains an archive day" "$T/cont.out" || bad+=" archive-rerun:$rc"
cont CHAIN=0 SOURCE=helius GITHUB_RUN_ATTEMPT=2 && [[ -e "$GD/dispatch.log" ]] || bad+=" helius"
[[ -z "$bad" ]] && ok "OF-2 r3 ruling 15: a re-run of the continue job never chains an archive day (Helius unchanged)" || no "OF-2 r3 continue re-run:$bad"
bad=""; gdreset
# 16: another archive-lane run not completed refuses a manual dispatch; this run does not.
python3 - "$GD/ds.json" "$(iso $(( now - 60 )))" <<'PY'
import json, sys
json.dump([{"databaseId": 641, "status": "in_progress", "conclusion": None, "createdAt": sys.argv[2], "updatedAt": sys.argv[2], "attempt": 1, "headBranch": "main", "displayTitle": "data-scan scan source=archive"}], open(sys.argv[1], "w"))
PY
rc=0; guard full 2026-07-22 || rc=$?; [[ $rc == 2 ]] && grep -q "other data-scan run(s) outside the Helius lane are not completed" "$T/gout.txt" || bad+=" other:$rc"
sed -i 's/"databaseId": 641/"databaseId": 700/' "$GD/ds.json"; guard full 2026-07-22 || bad+=" own-run"
[[ -z "$bad" ]] && ok "OF-2 r3 ruling 16: a manual dispatch is refused while another archive-lane run is not completed; the run's own entry does not count" || no "OF-2 r3 busy lane:$bad"
bad=""; gdreset
# 17: a probe step left with no conclusion on a completed attempt counts.
PROBE=null acrun 651 failure 120 notserved | acjson
ac env AC_STATUS=206; [[ ! -e "$A/curl.calls" ]] && grep -q "held (2): back-off" "$A/summary.md" || bad+=" null"
[[ -z "$bad" ]] && ok "OF-2 r3 ruling 17: a probe step with no conclusion (a lost runner) on a completed attempt counts as a failure" || no "OF-2 r3 null probe:$bad"
bad=""; gdreset
# 18: strict Retry-After; unclean or above 7 days records end=hold, which holds until a re-arm.
for v in "soon" "5.5" "Thu, 01 Jan 2099 00:00:00 UTC" "$(date -u -d "@$(( now + 8 * 86400 ))" '+%a, %d %b %Y %H:%M:%S GMT')" "700000"; do
  ac env AC_STATUS=429 AC_RA="$v"
  grep -qx "backoff_annotation=hold" "$A/output" && ! grep -q "^backoff_end=" "$A/output" || bad+=" [$v]"
done
acrun 661 failure 2880 notserved | acjson; echo '[{"title": "archive-backoff", "message": "end=hold"}]' > "$GD/ann-6610.json"
mkfx "$T/fxr3d" ARCHIVE_REARM_AT="$(iso $(( now - 3 * 86400 )))"
ACFX=$T/fxr3d/research/historical/ci ac env AC_STATUS=206
[[ ! -e "$A/curl.calls" ]] && grep -q "unclean or over-7-day Retry-After, or a probe failure has no archive-backoff annotation; only a reviewed change re-arms" "$A/summary.md" || bad+=" hold-2-days-later"
[[ -z "$bad" ]] && ok "OF-2 r3 ruling 18: a Retry-After that is not delta-seconds or an IMF-fixdate (soon, 5.5, a UTC date), or above 7 days, records end=hold, and that holds the chain two days later until a reviewed re-arm" || no "OF-2 r3 strict Retry-After:$bad"
bad=""; gdreset
# 20: --probe checks the day itself before any request.
for d in 2026-09-25 2026-07-24; do
  rm -f "$A/curl.calls"; rc=0
  GD="$GD" AC="$A" GH_BIN="$GD/bin/gh" CURL_BIN="$A/bin/curl" GH_REPO=o/r REF=main GITHUB_RUN_ATTEMPT=1 GITHUB_RUN_ID=900 GITHUB_STEP_SUMMARY="$A/summary.md" AC_STATUS=206 \
    bash "$FX/archive-check.sh" --probe "$d" > "$A/out.txt" 2>&1 || rc=$?
  [[ $rc == 2 && ! -e "$A/curl.calls" ]] || bad+=" $d:$rc"
done
[[ -z "$bad" ]] && ok "OF-2 r3 ruling 20: --probe refuses a day outside the allow-list, or without a retention value, before any request" || no "OF-2 r3 probe checks the day:$bad"
bad=""

# ---- OF-2 round 4 (docs/reviews/OF2.md rulings 21-30) ----
gdreset; bad=""; now=$(date -u +%s)
NG=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb; touch "$GD/noguard-$NG"
# 21. An old run re-run now (created 10 days ago, attempt 2, a commit without the guard)
# is read by updatedAt and stops the chain; a re-run of a guarded commit does not.
dsre() { python3 - "$GD/ds.json" "$(iso $(( now - 10 * 86400 )))" "$(iso $(( now - 120 * 60 )))" "$1" "$2" <<'PY'
import json, sys
json.dump([{"databaseId": 671, "status": "completed", "conclusion": "success", "createdAt": sys.argv[2], "updatedAt": sys.argv[3], "attempt": int(sys.argv[5]), "headBranch": "main", "headSha": sys.argv[4], "displayTitle": "data-scan"}], open(sys.argv[1], "w"))
PY
}
dsre "$NG" 2; ac env AC_STATUS=206
[[ ! -e "$A/curl.calls" ]] && grep -q "held (3): the chain is stopped: 1 run(s) since ARCHIVE_REARM_AT may have read the archive unguarded" "$A/summary.md" || bad+=" ds-rerun:$(cat "$A/summary.md")"
rc=0; guard full 2026-07-22 || rc=$?; [[ $rc == 2 ]] && grep -q "may have read the archive unguarded" "$T/gout.txt" || bad+=" ds-rerun-plan:$rc"
dsre "$NG" 1; ac env AC_STATUS=206; [[ $(wc -l < "$A/curl.calls" 2>/dev/null) == 1 ]] || bad+=" attempt1-default"
dsre aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa 2; ac env AC_STATUS=206; [[ $(wc -l < "$A/curl.calls" 2>/dev/null) == 1 ]] || bad+=" guarded-rerun"
dsre "$NG" 2; ac env AC_STATUS=206 GD_SHA_FAIL=1
[[ ! -e "$A/curl.calls" ]] && grep -q "held (2): the run history cannot be read" "$A/summary.md" || bad+=" sha-unreadable"
rm -f "$GD/ds.json"; { ATTEMPT=2 SHA=$NG acrun 672 success 30; } | acjson; ac env AC_STATUS=206
[[ ! -e "$A/curl.calls" ]] && grep -q "held (3): the chain is stopped: 1 run(s)" "$A/summary.md" || bad+=" ac-rerun"
[[ -z "$bad" ]] && ok "OF-2 r4 ruling 21: runs are read by updatedAt, so an old default-branch run (created 10 days ago) re-run now (attempt 2) from a commit without archive-guard.sh stops the chain (archive-check and a manual dispatch), for data-scan and archive-check alike; attempt 1, or a re-run of a guarded commit, does not; an unreadable commit holds" || no "OF-2 r4 re-run of old runs:$bad"
bad=""; gdreset; touch "$GD/noguard-$NG"
# 22. A scan job failed only in a guard step made no request: never a failure.
scanjobs() { python3 -c 'import json,sys; print(json.dumps({"jobs": [{"id": int(sys.argv[1]) * 10, "name": "scan (2026-07-22)", "conclusion": "failure", "steps": [{"name": n, "conclusion": "failure"} for n in sys.argv[2].split("|")] + [{"name": "Collect the back-off for the next day and run", "conclusion": "success"}]}, {"id": int(sys.argv[1]) * 10 + 1, "name": "continue", "conclusion": "failure", "steps": []}]}))' "$1" "$2" > "$GD/jobs-$1.json"; }
for st in "Archive guard before the scan" "Archive guard before QA" "Archive guard before the scan|Archive guard before QA"; do
  { dsrun 681 "data-scan scan source=archive" failure 190 180; dsrun 682 "data-scan scan source=archive" failure 170 160; dsrun 683 "data-scan scan source=archive" failure 150 140; } | dsjson
  for r in 681 682 683; do scanjobs $r "$st"; done
  ac env AC_STATUS=206; [[ $(wc -l < "$A/curl.calls" 2>/dev/null) == 1 ]] || bad+=" [$st]:$(cat "$A/summary.md")"
done
for r in 681 682 683; do scanjobs $r "Archive guard before QA|QA and determinism"; done
ac env AC_STATUS=206; [[ ! -e "$A/curl.calls" ]] && grep -q "held (2): back-off" "$A/summary.md" || bad+=" qa-failed-counts"
# guardqa skips the other-run and 60-min checks; volume runs never count as busy or as the lane's end
gdreset; touch "$GD/noguard-$NG"
python3 - "$GD/ds.json" "$(iso $(( now - 60 )))" <<'PY'
import json, sys
json.dump([{"databaseId": 691, "status": "queued", "conclusion": None, "createdAt": sys.argv[2], "updatedAt": sys.argv[2], "attempt": 1, "headBranch": "main", "headSha": "a" * 40, "displayTitle": "data-scan scan source=archive"},
           {"databaseId": 692, "status": "completed", "conclusion": "success", "createdAt": sys.argv[2], "updatedAt": sys.argv[2], "attempt": 1, "headBranch": "main", "headSha": "a" * 40, "displayTitle": "data-scan scan source=archive"}], open(sys.argv[1], "w"))
PY
rm -rf "$GP"; rc=0; guard attest 2026-07-22 "$GP" || rc=$?; [[ $rc == 2 ]] || bad+=" scan-guard-busy:$rc"
rm -rf "$GP"; guard attest 2026-07-22 "$GP" qa && [[ -f "$GP/2026-07-22" ]] || bad+=" qa-guard:$(cat "$T/gout.txt")"
sed -i 's/"data-scan scan source=archive"/"data-scan volume"/g' "$GD/ds.json"
rm -rf "$GP"; guard attest 2026-07-22 "$GP" && [[ -f "$GP/2026-07-22" ]] || bad+=" volume-not-busy:$(cat "$T/gout.txt")"
jq '[.[] | select(.databaseId != 691)]' "$GD/ds.json" > "$GD/ds2.json" && mv "$GD/ds2.json" "$GD/ds.json" # (hold 5 still waits for a queued volume run)
ac env AC_STATUS=206; [[ $(wc -l < "$A/curl.calls" 2>/dev/null) == 1 ]] || bad+=" volume-not-lane"
rc=0; guard attest 2026-07-22 "$GP" qx || rc=$?; [[ $rc == 2 ]] || bad+=" attest-usage:$rc"
[[ -z "$bad" ]] && ok "OF-2 r4 ruling 22: a scan job whose only failed steps are its guard steps (before the scan, before QA) is never counted (3 such runs: the probe goes); a QA failure still counts; the guard before QA (attest ... qa) skips the other-run and 60-min checks; a queued or just-ended data-scan volume run is neither busy nor the lane's end" || no "OF-2 r4 guard refusals:$bad"
bad=""; gdreset; touch "$GD/noguard-$NG"
# 23. Finalize and QA output go to the dataset side ($qlog), never the job log or summary.
C23="$T/cd23bin"; mkdir -p "$C23"
cat > "$C23/zeroed-scan" <<'STUB'
#!/usr/bin/env bash
# finalize: an empty dataset with its manifest; unit (the determinism rescan): the same files
echo "$*" >> "$T/zs.args"
case $1 in
  finalize) echo "QA-REPORT finalize counts"; while (( $# )); do [[ "$1" == -dataset ]] && ds=$2; shift; done; mkdir -p "$ds/qa"; echo '{}' > "$ds/manifest.json" ;;
  unit) while (( $# )); do case $1 in -out) o=$2 ;; -epoch) e=$2 ;; -from-slot) f=$2 ;; -to-slot) t=$2 ;; -state) st=$2 ;; esac; shift; done
        mkdir -p "$o/units/$e/$f-$t"; cp "$st/units/$e/$f-$t/"*.zst "$o/units/$e/$f-$t/" ;;
esac
STUB
cat > "$C23/node" <<'STUB'
#!/usr/bin/env bash
for a in "$@"; do [[ -d "$a/qa" ]] && { echo r > "$a/qa/report.md"; echo '{}' > "$a/qa/report.json"; echo '{}' > "$a/qa/parity.json"; echo '{}' > "$a/qa/volume.json"; }; done
[[ "$*" == */qa/* ]] && { echo "QA-REPORT blocks=123 account=So1aNaAccount slot=987654321"; echo "QA-REPORT stderr" >&2; }
[[ "$*" == *"${QA_FAIL_ON:-none}"* ]] && exit 1
exit 0
STUB
chmod +x "$C23"/*
cd23() { rm -rf "$T/cd23" "$T/cd23-assets" "$T/cd-ds"; mkdir -p "$T/cd23/units/1046/1-2" "$T/cd23/cache" "$T/cd-ds"; echo x > "$T/cd23/units/1046/1-2/blocks.csv.zst"
  echo '{"blocks": 3, "retention": "K2"}' > "$T/cd23/units/1046/1-2/stats.json"; : > "$T/summary.md"; : > "$T/zs.args"; gpass 2026-07-22 K2
  ARCHIVE_GO="$T/archive10.go" ARCHIVE_GUARD_DIR="$GP" FAKE_AVAIL=999000000000 DATASET_PARENT="$T/cd-ds" PATH="$C23:$PATH" GITHUB_STEP_SUMMARY="$T/summary.md" \
    bash "$FX/check-day.sh" 2026-07-22 "$T/cd23" "$T/cd23-assets" > "$T/out.txt" 2>&1; }
rc=0; cd23 || rc=$?
[[ $rc == 0 ]] && ! grep -q "QA-REPORT" "$T/out.txt" "$T/summary.md" && grep -q "^phase qa (2026-07-22): passed, " "$T/summary.md" || bad+=" pass:$rc"
rc=0; QA_FAIL_ON=check.mjs cd23 || rc=$?
l=$(ls "$T"/cd23/logs/qa/qa.log 2>/dev/null | head -1)
[[ $rc != 0 ]] && ! grep -q "QA-REPORT" "$T/out.txt" "$T/summary.md" && grep -q "^phase qa (2026-07-22): failed (exit 1)" "$T/summary.md" && [[ -n "$l" ]] && grep -q "QA-REPORT blocks=123" "$l" && grep -q "QA-REPORT stderr" "$l" || bad+=" fail:$rc"
for v in plain phase-no-redirect wrapper; do
  mkfx "$T/fxq"; c="$T/fxq/research/historical/ci"
  case $v in plain) echo 'node "$here/../qa/parity.ts" "$ds"' >> "$c/check-day.sh" ;; phase-no-redirect) sed -i 's| > "\$qlog/qa.log" 2>&1||' "$c/check-day.sh" ;;
    wrapper) echo 'run zeroed-scan finalize -out "$out" -dataset "$ds"' >> "$c/volume-day.sh" ;; esac
  ACFX=$c ac env AC_STATUS=206; [[ ! -e "$A/curl.calls" ]] && grep -q "prints scanner or QA output to the job log" "$A/summary.md" || bad+=" arm-$v"
done
python3 - "$here/../../../.github/workflows/data-scan.yml" <<'PY' || bad+=" workflow-prints"
import re, sys, yaml
for job in yaml.safe_load(open(sys.argv[1]))["jobs"].values():
    for st in job.get("steps", []):
        r = st.get("run", "")
        assert not re.search(r"report\.(md|json)|parity\.json|qa-log|-log/|qa/check\.mjs|parity\.ts", r), st
PY
[[ -z "$bad" ]] && ok "OF-2 r4 ruling 23: check-day's finalize and QA output (stdout and stderr) goes to the log directory next to the dataset, and the job log and summary carry only pass or fail and durations; arming refuses a QA call that prints to the job log (bare, through phase, or behind any wrapper); no data-scan step prints a QA report" || no "OF-2 r4 QA output:$bad"
bad=""; gdreset; touch "$GD/noguard-$NG"
# 24. Another branch: only a run whose scan job started, or a commit without the guard, is foreign.
BRANCH=old dsrun 701 "data-scan scan source=archive" failure 120 110 | dsjson
echo '{"jobs": [{"id": 7010, "name": "plan", "conclusion": "failure", "steps": [{"name": "Archive guard", "conclusion": "failure"}]}, {"id": 7011, "name": "scan (2026-07-22)", "conclusion": "skipped", "steps": []}]}' > "$GD/jobs-701.json"
ac env AC_STATUS=206; [[ $(wc -l < "$A/curl.calls" 2>/dev/null) == 1 ]] || bad+=" scan-skipped:$(cat "$A/summary.md")"
echo '{"jobs": [{"id": 7010, "name": "plan", "conclusion": "success", "steps": []}, {"id": 7011, "name": "scan (2026-07-22)", "conclusion": "success", "steps": []}]}' > "$GD/jobs-701.json"
ac env AC_STATUS=206; [[ ! -e "$A/curl.calls" ]] && grep -q "held (3): the chain is stopped: 1 run(s)" "$A/summary.md" || bad+=" scan-started"
echo '{"jobs": [{"id": 7010, "name": "plan", "conclusion": "failure", "steps": []}]}' > "$GD/jobs-701.json"
sed -i "s/\"headSha\": \"a*\"/\"headSha\": \"$NG\"/" "$GD/ds.json"
ac env AC_STATUS=206; [[ ! -e "$A/curl.calls" ]] && grep -q "held (3): the chain is stopped: 1 run(s)" "$A/summary.md" || bad+=" unguarded-commit"
[[ -z "$bad" ]] && ok "OF-2 r4 ruling 24: a data-scan run from another branch counts as foreign only when its scan job started or its commit lacks archive-guard.sh (a run stopped in the plan job does not)" || no "OF-2 r4 foreign scope:$bad"
bad=""; gdreset; touch "$GD/noguard-$NG"
# 26. Permissions are parsed, not matched: every form of a write grant refuses to arm.
pf() { mkfx "$T/fxp"; c="$T/fxp/research/historical/ci"; printf '%b' "$1" > "$T/fxp/.github/workflows/extra.yml"
  ACFX=$c ac env AC_STATUS=206; [[ ! -e "$A/curl.calls" ]] && grep -q "held (1): the archive chain is not armed: extra.yml" "$A/summary.md" || bad+=" check[$2]"
  rc=0; FXG=$c guard full 2026-07-22 || rc=$?; [[ $rc == 2 ]] || bad+=" plan[$2]:$rc"; }
J='jobs:\n  a:\n    runs-on: x\n    steps:\n      - run: research/historical/ci/scan-day.sh x\n'
pf "permissions:\n  contents: read\njobs:\n  a:\n    permissions:\n      contents: write\n    steps:\n      - run: research/historical/ci/scan-day.sh x\n" block
pf "permissions:\n  contents: read\njobs:\n  a:\n    permissions:\n      contents: \"write\"\n    steps:\n      - run: research/historical/ci/scan-day.sh x\n" double-quoted
pf "permissions:\n  contents: read\njobs:\n  a:\n    permissions:\n      contents: 'write'\n    steps:\n      - run: research/historical/ci/scan-day.sh x\n" single-quoted
pf "permissions:\n  contents: read\njobs:\n  a:\n    permissions: { contents: write }\n    steps:\n      - run: research/historical/ci/scan-day.sh x\n" flow
pf "permissions: { contents: write }\n$J" top-flow
pf "$J" removed-block
pf "permissions: write-all\n$J" write-all
pf "permissions:\n  contents: read\njobs:\n  a:\n    permissions: write-all\n    steps:\n      - run: research/historical/ci/scan-day.sh x\n" job-write-all
pf "permissions: read-all\n$J" read-all
pf "permissions:\n  contents: read\n  contents: write\n$J" duplicate-key
pf "jobs:\n  a:\n    steps:\n      - run: gh release download data-day-2026-07-22\n" day-release
mkfx "$T/fxp"; printf '%b' "permissions:\n  contents: read\njobs:\n  a:\n    permissions:\n      contents: read\n    steps:\n      - run: research/historical/ci/scan-day.sh x\n" > "$T/fxp/.github/workflows/extra.yml"
printf 'permissions:\n  contents: write\njobs:\n  a:\n    steps:\n      - run: gh release delete handoff --yes\n' > "$T/fxp/.github/workflows/unrelated.yml"
ACFX=$T/fxp/research/historical/ci ac env AC_STATUS=206; [[ $(wc -l < "$A/curl.calls" 2>/dev/null) == 1 ]] || bad+=" control:$(cat "$A/summary.md")"
# Ruling 32: the repeated permissions key of the volume-write bypass is what refuses it
byp 'python3 -c "import sys; p=sys.argv[1]; s=open(p).read(); i=s.index(\"  volume:\"); j=s.index(\"permissions:\", i); open(p,\"w\").write(s[:j] + \"permissions:\\n      contents: write\\n    \" + s[j:])" "$w"' volume-write-r32
grep -q "data-scan.yml does not parse as YAML (or repeats a key)" "$A/summary.md" || bad+=" repeated-key-reason"
# Ruling 31: deploy.yml (a key-handoff release) carries none of the archive-path markers
(. "$here/archive-guard.sh"; ! grep -qE "$ag_wf_marks" "$here/../../../.github/workflows/deploy.yml" && grep -qE "$ag_wf_marks" "$here/../../../.github/workflows/data-scan.yml") || bad+=" deploy-marked"
# Ruling 33: the parser used is logged; a parser that keeps a repeated key fails closed
mkfx "$T/fxp"; rc=0; FXG=$T/fxp/research/historical/ci guard full 2026-07-22 || rc=$?
[[ $rc == 0 ]] && grep -q "^permissions: parsed with python3 [0-9.]* yaml [0-9.]*" "$T/gout.txt" || bad+=" parser-logged:$rc"
NP="$T/noyaml"; mkdir -p "$NP"; printf '#!/usr/bin/env bash
[[ "$*" == *"import yaml"* ]] && exit 1
exec /usr/bin/python3 "$@"
' > "$NP/python3"
printf '#!/usr/bin/env bash
[[ "$1" == --version ]] && { echo "yq (stub) version v0"; exit 0; }
cat > /dev/null; echo a
' > "$NP/yq"; chmod +x "$NP"/*
rc=0; PATH="$NP:$PATH" FXG=$T/fxp/research/historical/ci guard full 2026-07-22 || rc=$?
[[ $rc == 2 ]] && grep -q "no YAML parser that refuses a repeated key (python3 with yaml)" "$T/gout.txt" || bad+=" no-strict-parser:$rc"
[[ -z "$bad" ]] && ok "OF-2 r4 ruling 26: arming parses every archive-path workflow's permissions: contents: write in a job (block, double-quoted, single-quoted, flow), at the top level, no top-level block, write-all (top or job), read-all and a repeated key all refuse (the volume-write bypass for that reason, ruling 32), as does a workflow naming a day release; deploy.yml carries no archive-path marker (31); the parser and its version are logged, and without python3's yaml (yq keeps a repeated key) arming fails closed (33); a workflow with explicit contents: read arms, and one that touches no archive path (a key-handoff release) is not checked" || no "OF-2 r4 permissions:$bad"
bad=""; gdreset; touch "$GD/noguard-$NG"
# 27. Whitespace around a Retry-After value is trimmed before the strict parse.
for v in " 30000" "30000 " "	30000	"; do
  ac env AC_STATUS=429 AC_RA="$v"; e=$(sed -n 's/^backoff_end=//p' "$A/output"); n=$(date -u +%s)
  (( ${e:-0} >= n + 29990 && ${e:-0} <= n + 30000 )) && grep -qx "backoff_annotation=$e" "$A/output" || bad+=" [$v]:$e"
done
[[ -z "$bad" ]] && ok "OF-2 r4 ruling 27: a Retry-After with spaces or tabs around 30000 is read as 30000 s, not as unclean (no end=hold)" || no "OF-2 r4 Retry-After whitespace:$bad"
bad=""; gdreset; touch "$GD/noguard-$NG"
# 29. archive-check from another branch: listed by unguarded-refs.sh and counted as foreign.
echo '[{"name": "main"}, {"name": "oldac"}, {"name": "acnoguard"}, {"name": "acnoscript"}]' > "$GD/branches.json"
cp "$here/../../../.github/workflows/archive-check.yml" "$GD/acwf-main.yml"; cp "$here/archive-check.sh" "$GD/acsh-main.sh"
printf 'jobs:\n  check:\n    steps:\n      - run: curl -r 0-63 https://files.old-faithful.net/x\n' > "$GD/acwf-oldac.yml"
cp "$GD/acwf-main.yml" "$GD/acwf-acnoguard.yml"; grep -v 'archive-guard.sh' "$here/archive-check.sh" > "$GD/acsh-acnoguard.sh"
cp "$GD/acwf-main.yml" "$GD/acwf-acnoscript.yml"
rc=0; out=$(GD="$GD" GH_BIN="$GD/bin/gh" GH_REPO=o/r bash "$here/unguarded-refs.sh" 2>"$T/ur.err") || rc=$?
[[ $rc == 0 && "$out" == $'oldac\nacnoguard\nacnoscript' ]] && grep -q "3 of 4 branches and tags" "$T/ur.err" || bad+=" list:$rc:$out"
! grep -vE '^gh api (--paginate )?repos/o/r/(branches|tags|contents/)' "$GD/gh.log" | grep -q . || bad+=" non-read-call"
{ BRANCH=feature acrun 711 success 30; } | acjson
jobsfile 711 "Archive probe (a failure unless served)=success"; ac env AC_STATUS=206
[[ ! -e "$A/curl.calls" ]] && grep -q "held (3): the chain is stopped: 1 run(s)" "$A/summary.md" || bad+=" foreign-check"
rc=0; guard full 2026-07-22 || rc=$?; [[ $rc == 2 ]] && grep -q "may have read the archive unguarded" "$T/gout.txt" || bad+=" foreign-plan:$rc"
mkfx "$T/fxr1m" ARCHIVE_REARM_AT="$(iso $(( now - 60 )))"
ACFX=$T/fxr1m/research/historical/ci ac env AC_STATUS=206; [[ $(wc -l < "$A/curl.calls" 2>/dev/null) == 1 ]] || bad+=" before-rearm"
[[ -z "$bad" ]] && ok "OF-2 r4 ruling 29: unguarded-refs.sh also lists branches whose archive-check.yml probes by itself or whose archive-check.sh lacks or does not source archive-guard.sh; a completed archive check from another branch since ARCHIVE_REARM_AT stops the chain (archive-check and a manual dispatch), one before a later re-arm does not" || no "OF-2 r4 archive-check branches:$bad"
bad=""; gdreset

# ---- OF-2 round 4 red team (docs/reviews/OF2.md rulings 36-42) ----
gdreset; bad=""; now=$(date -u +%s); touch "$GD/noguard-$NG"
# 36. The scanner's counts go to a private log next to the data, never the job log or summary.
o="$T/r36"; rm -rf "$o" "$o-log"; mkdir -p "$o"; : > "$T/summary.md"; rc=0; scan "$o" || rc=$?
[[ $rc == 0 ]] && ! grep -q "curve=5" "$T/out.txt" "$T/summary.md" && grep -q "curve=5" "$o/logs/run.log" || bad+=" scan-log:$rc"
for v in run unit; do
  mkfx "$T/fx36"; c="$T/fx36/research/historical/ci"
  echo "zeroed-scan $v -out \"\$out\" -from 2026-07-22" >> "$c/scan-day.sh"
  ACFX=$c ac env AC_STATUS=206; [[ ! -e "$A/curl.calls" ]] && grep -q "scan-day.sh line [0-9]* prints scanner or QA output to the job log" "$A/summary.md" || bad+=" arm-$v"
done
mkfx "$T/fx36"; c="$T/fx36/research/historical/ci"; echo 'zeroed-scan run -out "$out" | tee "$out/x.log"' >> "$c/scan-day.sh"
ACFX=$c ac env AC_STATUS=206; [[ ! -e "$A/curl.calls" ]] || bad+=" arm-tee"
mkfx "$T/fx36"; c="$T/fx36/research/historical/ci"; echo 'x=$(zeroed-scan unitlog -out "$out" 2>&1)' >> "$c/scan-day.sh"
ACFX=$c ac env AC_STATUS=206; [[ $(wc -l < "$A/curl.calls" 2>/dev/null) == 1 ]] || bad+=" captured-ok"
[[ -z "$bad" ]] && ok "OF-2 r4 ruling 36: a zeroed-scan run printing per-unit counts (curve=5) reaches only the private log next to the data, never the job log or summary; arming refuses an unredirected zeroed-scan run or unit line, or one piped to tee; a call captured with its stderr is accepted" || no "OF-2 r4 scanner output:$bad"
bad=""; gdreset; touch "$GD/noguard-$NG"
# 37. Tags are walked too.
echo '[{"name": "main"}]' > "$GD/branches.json"; echo '[{"name": "preview"}, {"name": "deploy"}]' > "$GD/tags.json"
printf 'jobs:\n  scan:\n    run: research/historical/ci/scan-day.sh "$DAY"\n' > "$GD/wf-tag-preview.yml"
printf 'jobs:\n  scan:\n    run: research/historical/ci/archive-guard.sh attest\n    run2: research/historical/ci/scan-day.sh\n' > "$GD/wf-tag-deploy.yml"
rc=0; out=$(GD="$GD" GH_BIN="$GD/bin/gh" GH_REPO=o/r bash "$here/unguarded-refs.sh" 2>"$T/ur.err") || rc=$?
[[ $rc == 0 && "$out" == "tag preview" ]] && grep -q "1 of 3 branches and tags" "$T/ur.err" || bad+=" tags:$rc:$out"
[[ -z "$bad" ]] && ok "OF-2 r4 ruling 37: unguarded-refs.sh also walks tags and lists an unguarded one as 'tag NAME' (read only)" || no "OF-2 r4 tags:$bad"
bad=""; gdreset; touch "$GD/noguard-$NG"
# 38. An archive check from another branch counts only if its probe ran or its commit lacks the guard.
{ BRANCH=feature acrun 721 failure 30; } | acjson
echo '{"jobs": [{"id": 7210, "name": "check", "conclusion": "failure", "steps": [{"name": "Holds", "conclusion": "failure"}, {"name": "Archive probe (a failure unless served)", "conclusion": "skipped"}]}]}' > "$GD/jobs-721.json"
ac env AC_STATUS=206; [[ $(wc -l < "$A/curl.calls" 2>/dev/null) == 1 ]] || bad+=" probe-skipped:$(cat "$A/summary.md")"
{ BRANCH=feature SHA=$NG acrun 721 failure 30; } | acjson; ac env AC_STATUS=206
[[ ! -e "$A/curl.calls" ]] && grep -q "held (3): the chain is stopped: 1 run(s)" "$A/summary.md" || bad+=" unguarded-commit"
[[ -z "$bad" ]] && ok "OF-2 r4 ruling 38: an archive check from another branch whose probe step was skipped, on a guarded commit, does not stop the chain; one from a commit without archive-guard.sh does" || no "OF-2 r4 off-branch checks:$bad"
bad=""; gdreset; touch "$GD/noguard-$NG"
# 39. Archive workflows: only contents and actions read (actions write where needed); no other scope; artifacts only resume-.
pw() { mkfx "$T/fx39"; w="$T/fx39/.github/workflows/data-scan.yml"; python3 - "$w" "$1" <<'PY'
import sys
p, v = sys.argv[1], sys.argv[2]; s = open(p).read()
if v == "pages":
    i = s.index("  volume:"); j = s.index("permissions:", i); k = s.index("\n", j)
    s = s[:k] + "\n      pages: write" + s[k:]
elif v == "scan-actions-write":
    i = s.index("\n  scan:"); j = s.index("actions: read", i); s = s[:j] + "actions: write" + s[j + len("actions: read"):]
elif v == "assemble-upload":
    i = s.index("\n  assemble:"); j = s.index("    steps:\n", i) + len("    steps:\n")
    s = s[:j] + "      - uses: actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02\n        with:\n          name: dataset\n          path: x\n" + s[j:]
elif v == "run-block":
    i = s.index("\n  assemble:"); j = s.index("    steps:\n", i) + len("    steps:\n")
    s = s[:j] + "      - run: zeroed-scan finalize -out x -dataset y\n" + s[j:]
open(p, "w").write(s)
PY
  ACFX=$T/fx39/research/historical/ci ac env AC_STATUS=206; [[ ! -e "$A/curl.calls" ]] && grep -q "held (1): the archive chain is not armed: data-scan.yml job $2" "$A/summary.md" || bad+=" [$1]"; }
pw pages "volume grants pages: write"; pw scan-actions-write "scan grants actions: write"; pw assemble-upload "assemble uploads an artifact (dataset)"; pw run-block "assemble step ? prints scanner or QA output"
mkfx "$T/fx39"; cp "$here/../../../.github/workflows/archive-check.yml" "$here/../../../.github/workflows/data-keep.yml" "$T/fx39/.github/workflows/"
ACFX=$T/fx39/research/historical/ci ac env AC_STATUS=206; [[ $(wc -l < "$A/curl.calls" 2>/dev/null) == 1 ]] || bad+=" control:$(cat "$A/summary.md")"
sed -i 's/^  actions: write$/  actions: write\n  checks: write/' "$T/fx39/.github/workflows/archive-check.yml"
ACFX=$T/fx39/research/historical/ci ac env AC_STATUS=206; [[ ! -e "$A/curl.calls" ]] && grep -q "archive-check.yml grants checks: write at the top level" "$A/summary.md" || bad+=" checks-write"
[[ -z "$bad" ]] && ok "OF-2 r4 ruling 39: in an archive workflow pages: write (volume job), actions: write outside archive-check's dispatch and data-scan's continue job, an upload-artifact in assemble, a scanner call in a run: block and checks: write all refuse to arm; archive-check.yml and data-keep.yml as they are arm" || no "OF-2 r4 scopes:$bad"
bad=""; gdreset; touch "$GD/noguard-$NG"
# 41. The volume-title skip holds only for a default-branch run of a guarded commit.
vol() { python3 - "$GD/ds.json" "$(iso $(( now - 60 )))" "$1" "$2" <<'PY'
import json, sys
json.dump([{"databaseId": 731, "status": "queued", "conclusion": None, "createdAt": sys.argv[2], "updatedAt": sys.argv[2], "attempt": 1, "headBranch": sys.argv[3], "headSha": sys.argv[4], "displayTitle": "data-scan volume source=archive"}], open(sys.argv[1], "w"))
PY
}
vol main aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa; guard full 2026-07-22 || bad+=" default-guarded"
vol other aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa; rc=0; guard full 2026-07-22 || rc=$?; [[ $rc == 2 ]] && grep -q "other data-scan run(s) outside the Helius lane are not completed" "$T/gout.txt" || bad+=" other-branch:$rc"
vol main "$NG"; rc=0; guard full 2026-07-22 || rc=$?; [[ $rc == 2 ]] && grep -q "are not completed" "$T/gout.txt" || bad+=" unguarded:$rc"
[[ -z "$bad" ]] && ok "OF-2 r4 ruling 41: a queued data-scan volume run is skipped as busy only on the default branch from a guarded commit; from another branch or an unguarded commit it holds the lane" || no "OF-2 r4 volume skip:$bad"
bad=""; gdreset; touch "$GD/noguard-$NG"
# 42 (amended by 49, 55, 61). Too many runs for one search fail closed; in-progress and queued runs are listed on their own.
guard full 2026-07-22 && grep -q "workflows/data-scan.yml/runs?status=in_progress&" "$GD/gh.log" && grep -q "workflows/archive-check.yml/runs?status=queued&" "$GD/gh.log" || bad+=" status-lists"
python3 - "$GD/ds.json" "$(iso $(( now - 3 * 86400 )))" <<'PY'
import json, sys
json.dump([{"databaseId": 1000 + i, "status": "completed", "conclusion": "success", "createdAt": sys.argv[2], "updatedAt": sys.argv[2], "attempt": 1, "headBranch": "main", "headSha": "a" * 40, "displayTitle": "data-scan volume"} for i in range(5001)], open(sys.argv[1], "w"))
PY
rc=0; guard full 2026-07-22 || rc=$?; [[ $rc == 2 ]] && grep -q "the run history cannot be read" "$T/gout.txt" || bad+=" cap:$rc"
[[ -z "$bad" ]] && ok "OF-2 r4 ruling 42 (as amended by 49): in-progress and queued runs are listed on their own (both workflows); each search fails closed at 1,000" || no "OF-2 r4 run list cap:$bad"
bad=""; gdreset

# ---- OF-2 round 6 (docs/reviews/OF2.md rulings 43-48, 44a) ----
gdreset; bad=""; now=$(date -u +%s); touch "$GD/noguard-$NG"
# 43, 49. Runs created since the earlier of 35 days ago and the re-arm are read page by
# page from the runs API (amended by 55, 61: each search fails closed at 1,000).
rN() { python3 - "$GD/ds.json" "$(iso $(( now - $1 * 86400 )))" "$2" <<'PY'
import json, sys
json.dump([{"databaseId": 2000 + i, "status": "completed", "conclusion": "success", "createdAt": sys.argv[2], "updatedAt": sys.argv[2], "attempt": 1, "headBranch": "main", "headSha": "a" * 40, "displayTitle": "data-scan volume"} for i in range(int(sys.argv[3]))], open(sys.argv[1], "w"))
PY
}
mkfx "$T/fx43" ARCHIVE_REARM_AT="$(iso $(( now - 3 * 86400 )))"
rN 40 500; FXG=$T/fx43/research/historical/ci guard full 2026-07-22 || bad+=" outside-window:$(tail -1 "$T/gout.txt")"
grep -q "workflows/data-scan.yml/runs?created=$(date -u -d "@$(( now - 35 * 86400 ))" +%FT%H)" "$GD/gh.log" || bad+=" created-35d"
for st in queued in_progress waiting requested pending; do grep -q "runs?status=$st&per_page=100" "$GD/gh.log" || bad+=" status-$st"; done
grep -q "^run history: gh version" "$T/gout.txt" || bad+=" version-logged"
mkfx "$T/fx49" ARCHIVE_REARM_AT="$(iso $(( now - 70 * 86400 )))"
rN 20 600; FXG=$T/fx49/research/historical/ci guard full 2026-07-22 || bad+=" 600-after-70d:$(tail -1 "$T/gout.txt")"
grep -q "runs?created=$(date -u -d "@$(( now - 70 * 86400 ))" +%FT%H)" "$GD/gh.log" || bad+=" created-from-rearm"
rN 20 5001; rc=0; FXG=$T/fx49/research/historical/ci guard full 2026-07-22 || rc=$?; [[ $rc == 2 ]] && grep -q "the run history cannot be read" "$T/gout.txt" || bad+=" over-5000:$rc"
rN 20 10; rc=0; GD_RUNS_FAIL=1 FXG=$T/fx49/research/historical/ci guard full 2026-07-22 || rc=$?; [[ $rc == 2 ]] && grep -q "the run history cannot be read" "$T/gout.txt" || bad+=" api-error:$rc"
[[ -z "$bad" ]] && ok "OF-2 r6/r7 rulings 43, 49: runs are read page by page from the runs API, created since the earlier of 35 days ago and ARCHIVE_REARM_AT, plus every queued, in-progress, waiting, requested or pending run; 500 runs outside the window and 600 runs 70 days after a re-arm pass; more runs than one search returns (5,001 in one slice) or an API error fail closed; the gh version is logged" || no "OF-2 r6 run window:$bad"
bad=""; gdreset; touch "$GD/noguard-$NG"
# 44, 44a. The progress cache is sealed: no plaintext saved, a wrong key or a changed byte refused with nothing read.
CC="$here/cache-crypt.sh"; cr="$T/cc"; rm -rf "$cr"; mkdir -p "$cr/data/units/1046/1-2"; echo "curve=5 secret-unit-bytes" > "$cr/data/units/1046/1-2/a.zst"
DATA_STORE_TOKEN=tokA bash "$CC" seal "$cr/data" "$cr/sealed" data-scan-2026-07-22- > /dev/null || bad+=" seal"
[[ "$(cd "$cr/sealed" && ls | tr '\n' ' ')" == "progress.enc progress.iv progress.kid progress.mac " ]] && ! grep -rq "secret-unit-bytes" "$cr/sealed" || bad+=" plaintext"
DATA_STORE_TOKEN=tokA bash "$CC" check "$cr/sealed" || bad+=" check"
cp -r "$cr/sealed" "$cr/s2"; rc=0; DATA_STORE_TOKEN=tokB bash "$CC" open "$cr/s2" "$cr/o2" data-scan-2026-07-22- 2> "$T/cc.err" || rc=$?
[[ $rc == 2 && ! -e "$cr/o2" ]] && grep -q "sealed with another key" "$T/cc.err" || bad+=" wrong-key:$rc"
cp -r "$cr/sealed" "$cr/s3"; printf 'X' | dd of="$cr/s3/progress.enc" bs=1 seek=5 conv=notrunc 2>/dev/null
rc=0; DATA_STORE_TOKEN=tokA bash "$CC" open "$cr/s3" "$cr/o3" data-scan-2026-07-22- 2> "$T/cc.err" || rc=$?; [[ $rc == 2 && ! -e "$cr/o3" ]] && grep -q "fails its MAC" "$T/cc.err" || bad+=" tampered:$rc"
cp -r "$cr/sealed" "$cr/s4"; echo x > "$cr/s4/plain.txt"; rc=0; DATA_STORE_TOKEN=tokA bash "$CC" open "$cr/s4" "$cr/o4" data-scan-2026-07-22- 2>/dev/null || rc=$?; [[ $rc == 2 ]] || bad+=" extra-file:$rc"
rc=0; DATA_STORE_TOKEN= bash "$CC" kid > /dev/null 2>&1 || rc=$?; [[ $rc == 2 ]] || bad+=" no-token:$rc"
DATA_STORE_TOKEN=tokA bash "$CC" open "$cr/sealed" "$cr/o1" data-scan-2026-07-22- > /dev/null && cmp -s "$cr/data/units/1046/1-2/a.zst" "$cr/o1/units/1046/1-2/a.zst" && [[ ! -e "$cr/sealed" ]] || bad+=" round-trip"
python3 - "$here/../../../.github/workflows/data-scan.yml" <<'PY' || bad+=" workflow"
import sys, yaml
steps = yaml.safe_load(open(sys.argv[1]))["jobs"]["scan"]["steps"]
by = {s.get("id") or s.get("name"): s for s in steps}
ids = [s.get("id") or s.get("name") for s in steps]
for k in ("cachekid", "openprogress", "seal", "sealqa"):
    s = by[k]
    assert "cache-crypt.sh" in s["run"] and s["run"].startswith("/usr/bin/env -i PATH=/usr/bin:/bin ") and s["env"]["DATA_STORE_TOKEN"] == "${{ secrets.DATA_STORE_TOKEN }}", s
assert ids.index("cachekid") < ids.index("pickprogress") < ids.index("restore") == ids.index("openprogress") - 1 < ids.index("record"), ids
assert ids.index("shrink") < ids.index("seal") < ids.index("save") and ids.index("sealqa") == ids.index("Save progress after QA") - 1, ids
for s in steps:
    if "actions/cache" in s.get("uses", "") and "data-scan-backoff" not in str(s) and "archive-backoff" not in str(s) and "data-rpc-assets" not in str(s):
        assert s["with"]["path"] == "${{ runner.temp }}/work/sealed" + ("-logs" if str(s["with"]["key"]).endswith("-logs") else "") and "-k${{ steps.cachekid.outputs.kid }}-" in s["with"]["key"] or "pickprogress" in s["with"]["key"], s
# the token reaches only clean guard, crypt and store steps, never scan, trim or QA
for s in steps:
    if "DATA_STORE_TOKEN" in str(s.get("env", "")):
        assert s["run"].startswith("/usr/bin/env -i ") and any(x in s["run"] for x in ("archive-guard.sh", "cache-crypt.sh", "publish-day.sh", "publish-volume.sh", "storage-check.sh", "prior-fetch.sh", "margin-fetch.sh")), s
for k in ("scan", "qa"):
    assert "DATA_STORE_TOKEN" not in str(by[k]), k
PY
mkfx "$T/fx44"; sed -i 's|          path: ${{ runner.temp }}/work/sealed\n          key: ${{ inputs.source|X|' "$T/fx44/.github/workflows/data-scan.yml"
python3 - "$T/fx44/.github/workflows/data-scan.yml" <<'PY'
import sys
p = sys.argv[1]; s = open(p).read(); i = s.index("      - name: Save progress\n"); j = s.index("path: ${{ runner.temp }}/work/sealed", i)
open(p, "w").write(s[:j] + "path: ${{ runner.temp }}/work/data" + s[j + len("path: ${{ runner.temp }}/work/sealed"):])
PY
ACFX=$T/fx44/research/historical/ci ac env AC_STATUS=206; [[ ! -e "$A/curl.calls" ]] && grep -q "Save progress caches archive-derived progress unsealed (path \${{ runner.temp }}/work/data)" "$A/summary.md" || bad+=" arm-unsealed"
[[ -z "$bad" ]] && ok "OF-2 r6 rulings 44, 44a: the progress cache is sealed (only progress.enc/.iv/.kid/.mac, no plaintext byte); another key, a changed byte or an extra file is refused before anything is read; no token, no key; data-scan derives the key id, opens right after the restore and seals right before each save, in clean shells, and the token never reaches scan or QA; arming refuses a progress cache saved from an unsealed path" || no "OF-2 r6 sealed cache:$bad"
bad=""; gdreset; touch "$GD/noguard-$NG"
# 45. The red team's three lines: a path-prefixed call, a bash -c call, a redirect into the step summary.
for v in path dash-c summary; do
  mkfx "$T/fx45"; c="$T/fx45/research/historical/ci"
  case $v in
    path) echo '"$RUNNER_TEMP/bin/zeroed-scan" run -out "$out"' >> "$c/scan-day.sh" ;;
    dash-c) echo "bash -c 'zeroed-scan unit -out x'" >> "$c/scan-day.sh" ;;
    summary) echo 'zeroed-scan run -out "$out" > "$GITHUB_STEP_SUMMARY" 2>&1' >> "$c/scan-day.sh" ;;
  esac
  ACFX=$c ac env AC_STATUS=206; [[ ! -e "$A/curl.calls" ]] && grep -q "scan-day.sh line [0-9]* prints scanner or QA output to the job log" "$A/summary.md" || bad+=" [$v]"
done
mkfx "$T/fx45"; mkdir -p "$T/fx45/tools"; echo 'zeroed-scan run -out "$out"' > "$T/fx45/tools/x.sh"
python3 - "$T/fx45/.github/workflows/data-scan.yml" <<'PY'
import sys
p = sys.argv[1]; s = open(p).read(); i = s.index("\n  assemble:"); j = s.index("    steps:\n", i) + len("    steps:\n")
open(p, "w").write(s[:j] + "      - run: bash tools/x.sh\n" + s[j:])
PY
ACFX=$T/fx45/research/historical/ci ac env AC_STATUS=206; [[ ! -e "$A/curl.calls" ]] && grep -q "tools/x.sh line 1 (called by data-scan.yml job assemble" "$A/summary.md" || bad+=" outside-ci"
[[ -z "$bad" ]] && ok "OF-2 r6 ruling 45: arming refuses a scanner call after a path or quote, inside bash -c, or redirected into GITHUB_STEP_SUMMARY, and checks the scripts outside ci/ a workflow step calls" || no "OF-2 r6 checker bypasses:$bad"
bad=""; gdreset; touch "$GD/noguard-$NG"
# 46. Local composite actions are checked like a job; the whole actions/upload-* family refuses.
lc() { mkfx "$T/fx46"; mkdir -p "$T/fx46/.github/actions/x"; printf '%b' "$1" > "$T/fx46/.github/actions/x/action.yml"
  python3 - "$T/fx46/.github/workflows/data-scan.yml" "$2" <<'PY'
import sys
p, line = sys.argv[1], sys.argv[2]; s = open(p).read(); i = s.index("\n  assemble:"); j = s.index("    steps:\n", i) + len("    steps:\n")
open(p, "w").write(s[:j] + "      - " + line + "\n" + s[j:])
PY
  ACFX=$T/fx46/research/historical/ci ac env AC_STATUS=206; }
lc 'runs:\n  using: composite\n  steps:\n    - uses: actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02\n      with:\n        name: x\n' 'uses: ./.github/actions/x'
[[ ! -e "$A/curl.calls" ]] && grep -q "uploads an artifact" "$A/summary.md" || bad+=" composite-upload"
lc 'runs:\n  using: composite\n  steps:\n    - run: zeroed-scan run -out y\n      shell: bash\n' 'uses: ./.github/actions/x'
[[ ! -e "$A/curl.calls" ]] && grep -q "prints scanner or QA output" "$A/summary.md" || bad+=" composite-run"
lc 'runs:\n  using: node20\n  main: x.js\n' 'uses: ./.github/actions/x'
[[ ! -e "$A/curl.calls" ]] && grep -q "is not a composite action" "$A/summary.md" || bad+=" node-action"
lc 'runs:\n  using: composite\n  steps:\n    - run: echo ok\n      shell: bash\n' 'uses: ./.github/actions/x'
[[ $(wc -l < "$A/curl.calls" 2>/dev/null) == 1 ]] || bad+=" clean-composite:$(cat "$A/summary.md")"
lc 'runs:\n  using: composite\n  steps: []\n' 'uses: actions/upload-pages-artifact@56afc609e74202658d3ffba0e8f6dda462b719fa'
[[ ! -e "$A/curl.calls" ]] && grep -q "uploads an artifact (actions/upload-pages-artifact" "$A/summary.md" || bad+=" upload-pages"
[[ -z "$bad" ]] && ok "OF-2 r6 ruling 46: a local composite action is checked like a job (an upload or an unredirected scanner call inside it refuses; a clean one arms), a non-composite local action refuses, and actions/upload-pages-artifact refuses like upload-artifact" || no "OF-2 r6 composites:$bad"
bad=""; gdreset; touch "$GD/noguard-$NG"
# 47. Each commit's guard check is asked once.
{ ATTEMPT=2 acrun 741 success 30; ATTEMPT=2 acrun 742 success 40; } | acjson
python3 - "$GD/ds.json" "$(iso $(( now - 3600 )))" <<'PY'
import json, sys
json.dump([{"databaseId": 750 + i, "status": "completed", "conclusion": "success", "createdAt": sys.argv[2], "updatedAt": sys.argv[2], "attempt": 2, "headBranch": "main", "headSha": "a" * 40, "displayTitle": "data-scan"} for i in range(3)], open(sys.argv[1], "w"))
PY
guard full 2026-07-22 || bad+=" guard:$(tail -1 "$T/gout.txt")"
[[ $(grep -c "contents/research/historical/ci/archive-guard.sh?ref=aaaaaaaa" "$GD/gh.log") == 1 ]] || bad+=" calls:$(grep -c "archive-guard.sh?ref=" "$GD/gh.log")"
[[ -z "$bad" ]] && ok "OF-2 r6 ruling 47: one commit behind five re-runs (two archive checks, three scans) is checked for archive-guard.sh with one contents call" || no "OF-2 r6 sha cache:$bad"
bad=""; gdreset
# 48. A tag and a branch with one name are each checked, as refs/tags/NAME and refs/heads/NAME.
echo '[{"name": "main"}, {"name": "preview"}]' > "$GD/branches.json"; echo '[{"name": "preview"}]' > "$GD/tags.json"
printf 'jobs:\n  scan:\n    run: research/historical/ci/archive-guard.sh attest\n    run2: research/historical/ci/scan-day.sh\n' > "$GD/wf-preview.yml"
printf 'jobs:\n  scan:\n    run: research/historical/ci/scan-day.sh "$DAY"\n' > "$GD/wf-tag-preview.yml"
rc=0; out=$(GD="$GD" GH_BIN="$GD/bin/gh" GH_REPO=o/r bash "$here/unguarded-refs.sh" 2>"$T/ur.err") || rc=$?
[[ $rc == 0 && "$out" == "tag preview" ]] && grep -q "contents/.github/workflows/data-scan.yml?ref=refs/tags/preview" "$GD/gh.log" && grep -q "contents/.github/workflows/data-scan.yml?ref=refs/heads/preview" "$GD/gh.log" || bad+=" same-name:$rc:$out"
[[ -z "$bad" ]] && ok "OF-2 r6 ruling 48: a branch and a tag both named preview are read as refs/heads/preview and refs/tags/preview; only the unguarded tag is listed" || no "OF-2 r6 tag refs:$bad"
bad=""; gdreset

# ---- OF-3 ruling 24: a failed day's reasons are saved with its progress, sealed ----
bad=""
o="$T/r24"; rm -rf "$o"; mkdir -p "$o"; rc=0; SCAN_FAIL_RC=3 scan "$o" || rc=$?
[[ $rc != 0 ]] && grep -q "curve=5" "$o/logs/run.log" && ! grep -q "curve=5" "$T/out.txt" "$T/summary.md" || bad+=" scan-fail:$rc"
rc=0; QA_FAIL_ON=check.mjs cd23 || rc=$?; [[ $rc != 0 && -f "$T/cd23/logs/qa/qa.log" ]] || bad+=" qa-fail:$rc"
for d in "$o" "$T/cd23"; do
  rm -rf "$T/r24s"; DATA_STORE_TOKEN=tok24 bash "$here/cache-crypt.sh" seal "$d" "$T/r24s" data-scan-2026-07-22- > /dev/null 2>&1 || bad+=" seal"
  ! grep -rqE "curve=5|QA-REPORT" "$T/r24s" || bad+=" plaintext"
  rm -rf "$T/r24o"; DATA_STORE_TOKEN=tok24 bash "$here/cache-crypt.sh" open "$T/r24s" "$T/r24o" data-scan-2026-07-22- > /dev/null 2>&1 && grep -rqE "curve=5|QA-REPORT blocks=123" "$T/r24o/logs" || bad+=" readable"
done
mkk2; rc=0; TRIM_FAIL_ON=3-4 td 2026-07-22 - || rc=$?
[[ $rc != 0 ]] && grep -q "trim-counts kept=7" "$T/tk2/logs/trim.log" && ! grep -q "trim-counts" "$T/out.txt" || bad+=" trim-fail:$rc"
rm -rf "$T/r24s"; DATA_STORE_TOKEN=tok24 bash "$here/cache-crypt.sh" seal "$T/tk2" "$T/r24s" data-scan-2026-07-22- > /dev/null 2>&1 && ! grep -rq "trim-counts" "$T/r24s" || bad+=" trim-sealed"
[[ -z "$bad" ]] && ok "OF-3 ruling 24: a failed scan's, trim's and QA's output stay in the day's progress (logs/), so the sealed cache carries them with no plaintext byte and they read back after opening" || no "OF-3 failed-day logs:$bad"

# ---- OF-2 round 7 (docs/reviews/OF2.md rulings 49-53; 49 is with 43 above) ----
gdreset; bad=""; now=$(date -u +%s); touch "$GD/noguard-$NG"
# 50. The MAC binds the cache key prefix: day A's entry restored under day B's name is refused.
c50="$T/c50"; rm -rf "$c50"; mkdir -p "$c50/a/units/1/2"; echo unit > "$c50/a/units/1/2/x.zst"
DATA_STORE_TOKEN=t50 bash "$here/cache-crypt.sh" seal "$c50/a" "$c50/s" data-scan-2026-07-22- >/dev/null 2>&1 || bad+=" seal"
rc=0; DATA_STORE_TOKEN=t50 bash "$here/cache-crypt.sh" open "$c50/s" "$c50/o" data-scan-2026-07-23- 2> "$T/c50.err" || rc=$?
[[ $rc == 2 && ! -e "$c50/o" ]] && grep -q "sealed for another day or source" "$T/c50.err" || bad+=" other-day:$rc"
rc=0; DATA_STORE_TOKEN=t50 bash "$here/cache-crypt.sh" open "$c50/s" "$c50/o" data-rpc-2026-07-22- 2>/dev/null || rc=$?; [[ $rc == 2 && ! -e "$c50/o" ]] || bad+=" other-source:$rc"
DATA_STORE_TOKEN=t50 bash "$here/cache-crypt.sh" open "$c50/s" "$c50/o" data-scan-2026-07-22- >/dev/null 2>&1 && [[ -f "$c50/o/units/1/2/x.zst" ]] || bad+=" same-day"
python3 - "$here/../../../.github/workflows/data-scan.yml" <<'PY' || bad+=" workflow-prefix"
import sys, yaml
steps = yaml.safe_load(open(sys.argv[1]))["jobs"]["scan"]["steps"]
by = {s.get("id"): s for s in steps}
for k in ("openprogress", "seal", "sealqa"):
    assert by[k]["env"]["PREFIX"] == by["pickprogress"]["env"]["PREFIX"] and by[k]["run"].rstrip().endswith('"$PREFIX"') and 'PREFIX="$PREFIX"' in by[k]["run"], k
assert by["sealassets"]["env"]["PREFIX"] == "data-rpc-assets-${{ matrix.day }}-" and by["sealassets"]["run"].rstrip().endswith('"$PREFIX"'), by["sealassets"]
PY
[[ -z "$bad" ]] && ok "OF-2 r7 ruling 50: the MAC binds the cache key prefix: day 07-22's sealed progress opened as 07-23's, or as a Helius entry, is refused with nothing read; data-scan passes the same prefix to seal and open" || no "OF-2 r7 prefix binding:$bad"
bad=""; gdreset; touch "$GD/noguard-$NG"
# 51. Helius assets are sealed too; arming refuses while an unsealed progress or assets entry remains.
echo '{"actions_caches": [{"key": "data-rpc-assets-2026-09-21-37185822426-1", "ref": "refs/heads/main"}, {"key": "data-scan-backoff-1-1-2026-07-22", "ref": "refs/heads/main"}]}' > "$GD/caches.json"
KEEPCACHE=1 ac env AC_STATUS=206; [[ ! -e "$A/curl.calls" ]] && grep -q "held (3): 1 Actions cache entries hold progress or assets unsealed (data-rpc-assets-2026-09-21-37185822426-1" "$A/summary.md" || bad+=" check-unsealed"
rc=0; guard full 2026-07-22 || rc=$?; [[ $rc == 2 ]] && grep -q "the owner decides whether to delete them" "$T/gout.txt" || bad+=" plan-unsealed:$rc"
echo '{"actions_caches": [{"key": "data-rpc-assets-2026-09-21-k0123456789ab-1-1", "ref": "refs/heads/main"}, {"key": "data-scan-2026-07-22-k0123456789ab-1-1", "ref": "refs/pull/3/merge"}, {"key": "data-scan-backoff-1-1-2026-07-22", "ref": "refs/heads/main"}]}' > "$GD/caches.json"
KEEPCACHE=1 ac env AC_STATUS=206; [[ $(wc -l < "$A/curl.calls" 2>/dev/null) == 1 ]] || bad+=" sealed-ok:$(cat "$A/summary.md")"
rc=0; GD_CACHE_FAIL=1 guard full 2026-07-22 || rc=$?; [[ $rc == 2 ]] || bad+=" unreadable:$rc"
mkfx "$T/fx51"; python3 - "$T/fx51/.github/workflows/data-scan.yml" <<'PY'
import sys
p = sys.argv[1]; s = open(p).read(); s = s.replace("path: ${{ runner.temp }}/work/sealed-assets", "path: ${{ runner.temp }}/work/assets", 1); open(p, "w").write(s)
PY
rm -f "$GD/caches.json"; ACFX=$T/fx51/research/historical/ci ac env AC_STATUS=206; [[ ! -e "$A/curl.calls" ]] && grep -q "caches archive-derived progress unsealed (path \${{ runner.temp }}/work/assets)" "$A/summary.md" || bad+=" arm-assets-path"
[[ -z "$bad" ]] && ok "OF-2 r7 ruling 51: an unsealed data-rpc-assets entry (09-21's kind) holds archive-check and refuses a manual dispatch until the owner decides; sealed entries on any ref and the back-off state pass; an unreadable cache list fails closed; arming refuses Helius assets saved from an unsealed path" || no "OF-2 r7 sealed assets:$bad"
bad=""; gdreset; touch "$GD/noguard-$NG"
# 52. The AES key never reaches an argument: openssl reads it on a file descriptor.
! grep -qE -- 'openssl[^#]* -K |-K "\$' "$here/cache-crypt.sh" && grep -q -- '-pass fd:3' "$here/cache-crypt.sh" || bad+=" static"
c52="$T/c52"; rm -rf "$c52"; mkdir -p "$c52/a"; head -c 3000000 /dev/urandom > "$c52/a/big"
OB="$T/obin"; mkdir -p "$OB"; printf '#!/usr/bin/env bash\necho "$*" >> "%s"\nexec /usr/bin/openssl "$@"\n' "$T/openssl.args" > "$OB/openssl"; chmod +x "$OB/openssl"; : > "$T/openssl.args"
ek=$(DATA_STORE_TOKEN=t52 python3 -c 'import hashlib, hmac, os; print(hmac.new(os.environ["DATA_STORE_TOKEN"].encode(), b"zeroed-archive-cache-v1 enc", hashlib.sha256).hexdigest())')
PATH="$OB:$PATH" DATA_STORE_TOKEN=t52 bash "$here/cache-crypt.sh" seal "$c52/a" "$c52/s" data-scan-2026-07-22- 2> "$T/c52.err" > /dev/null &&
  PATH="$OB:$PATH" DATA_STORE_TOKEN=t52 bash "$here/cache-crypt.sh" open "$c52/s" "$c52/o" data-scan-2026-07-22- 2>/dev/null >/dev/null && cmp -s "$c52/a/big" "$c52/o/big" || bad+=" round-trip"
[[ -s "$T/openssl.args" ]] && ! grep -q "$ek" "$T/openssl.args" && grep -q "^cache-crypt: OpenSSL" "$T/c52.err" || bad+=" argv:$(cat "$T/openssl.args")"
[[ -z "$bad" ]] && ok "OF-2 r7 ruling 52: the derived AES key never appears in openssl's arguments (read on fd 3); the openssl version is logged; a 3 MB entry round-trips" || no "OF-2 r7 key off argv:$bad"
bad=""; gdreset; touch "$GD/noguard-$NG"
# 53. Redirect targets are the private log directories only, each assigned under $out or $RUNNER_TEMP; no scanner through a variable.
for v in other-var qlog-elsewhere via-var via-lookup; do
  mkfx "$T/fx53"; c="$T/fx53/research/historical/ci"
  case $v in
    other-var) echo 'zeroed-scan run -out "$out" > "$pubdir/run.log" 2>&1' >> "$c/scan-day.sh" ;;
    qlog-elsewhere) sed -i 's|^qlog="\$out/logs/qa"|qlog="/srv/www/qa"|' "$c/check-day.sh"; grep -q '^qlog="/srv/www/qa"' "$c/check-day.sh" || bad+=" setup-qlog" ;;
    via-var) printf 'zs=zeroed-scan\n"$zs" run -out "$out"\n' >> "$c/scan-day.sh" ;;
    via-lookup) printf 'zs=$(command -v zeroed-scan)\n"$zs" run -out "$out"\n' >> "$c/scan-day.sh" ;;
  esac
  ACFX=$c ac env AC_STATUS=206; [[ ! -e "$A/curl.calls" ]] && grep -q "prints scanner or QA output to the job log" "$A/summary.md" || bad+=" [$v]"
done
[[ -z "$bad" ]] && ok "OF-2 r7 ruling 53: arming refuses a scanner redirect to any directory but \$qlog, \$slog or \$tlog, a log directory assigned outside \$out or \$RUNNER_TEMP, and a scanner binary held in a variable or looked up with command -v" || no "OF-2 r7 redirect targets:$bad"
bad=""; gdreset

# ---- OF-2 round 8 (docs/reviews/OF2.md rulings 55-61; OF-3 rulings 26, 27) ----
gdreset; bad=""; now=$(date -u +%s); touch "$GD/noguard-$NG"
# 55, 61. A search returns at most 1,000 rows: 1,001 runs in one slice (or one status) fail closed; 1,200 across slices are all read.
rM() { python3 - "$GD/ds.json" "$now" "$1" "$2" "$3" <<'PY'
import json, sys, datetime
out, now, n, days, st = sys.argv[1], int(sys.argv[2]), int(sys.argv[3]), [int(d) for d in sys.argv[4].split(",")], sys.argv[5]
iso = lambda t: datetime.datetime.fromtimestamp(t, datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
runs = [{"databaseId": 3000 + i, "status": st, "conclusion": "success" if st == "completed" else None, "createdAt": iso(now - days[i % len(days)] * 86400), "updatedAt": iso(now - days[i % len(days)] * 86400),
         "attempt": 1, "headBranch": "main", "headSha": "a" * 40, "displayTitle": "data-scan volume"} for i in range(n)]
# the oldest run is an unguarded scan from another branch: seen only if every row is read
runs.append({"databaseId": 2999, "status": "completed", "conclusion": "success", "createdAt": iso(now - max(days) * 86400 - 60), "updatedAt": iso(now - max(days) * 86400 - 60),
             "attempt": 1, "headBranch": "old", "headSha": "b" * 40, "displayTitle": "data-scan"})
json.dump(runs, open(out, "w"))
PY
}
mkfx "$T/fx55" ARCHIVE_REARM_AT="$(iso $(( now - 30 * 86400 )))"
rM 1200 2,10 completed; rc=0; FXG=$T/fx55/research/historical/ci guard full 2026-07-22 || rc=$?
[[ $rc == 2 ]] && grep -q "may have read the archive unguarded" "$T/gout.txt" || bad+=" sliced-1200:$rc:$(tail -1 "$T/gout.txt")"
rM 1001 2 completed; rc=0; guard full 2026-07-22 || rc=$?; [[ $rc == 2 ]] && grep -q "the run history cannot be read" "$T/gout.txt" || bad+=" slice-1001:$rc"
rM 998 2 completed; guard full 2026-07-22 2>/dev/null; grep -q "may have read the archive unguarded" "$T/gout.txt" || bad+=" slice-999"
rM 1001 2 queued; rc=0; guard full 2026-07-22 || rc=$?; [[ $rc == 2 ]] && grep -q "the run history cannot be read" "$T/gout.txt" || bad+=" status-1001:$rc"
[[ -z "$bad" ]] && ok "OF-2 r8 rulings 55, 61: the window is read in created slices; 1,200 runs across two slices are all read (the oldest, an unguarded scan, stops the chain); a slice or a status query of 1,001 runs (GitHub returns 1,000) fails closed" || no "OF-2 r8 search cap:$bad"
bad=""; gdreset; touch "$GD/noguard-$NG"
# 56. Only the default branch's cache entries count.
echo '{"actions_caches": [{"key": "data-scan-2026-07-22-1-1", "ref": "refs/pull/7/merge"}]}' > "$GD/caches.json"
KEEPCACHE=1 ac env AC_STATUS=206; [[ $(wc -l < "$A/curl.calls" 2>/dev/null) == 1 ]] || bad+=" pr-ref:$(cat "$A/summary.md")"
echo '{"actions_caches": [{"key": "data-scan-2026-07-22-1-1", "ref": "refs/heads/main"}]}' > "$GD/caches.json"
KEEPCACHE=1 ac env AC_STATUS=206; [[ ! -e "$A/curl.calls" ]] && grep -q "hold progress or assets unsealed" "$A/summary.md" || bad+=" default-ref"
grep -q "actions/caches?key=data-&ref=refs/heads/main&" "$GD/gh.log" || bad+=" ref-query"
[[ -z "$bad" ]] && ok "OF-2 r8 ruling 56: an unsealed entry on a PR ref does not halt arming; the same key on the default branch does; the list asks for the default branch's ref" || no "OF-2 r8 cache ref:$bad"
bad=""; gdreset; touch "$GD/noguard-$NG"
# 57 (with OF-3 26). One case per form.
f57() { mkfx "$T/fx57"; c="$T/fx57/research/historical/ci"; printf '%s\n' "$1" >> "$c/scan-day.sh"
  ACFX=$c ac env AC_STATUS=206; [[ ! -e "$A/curl.calls" ]] && grep -q "scan-day.sh line [0-9]* prints scanner or QA output to the job log: $2" "$A/summary.md" || bad+=" [$1]"; }
f57 'ln -sf /dev/stdout "$slog/run.log"' "log directory linked or read out"
f57 'cat "$slog/run.log"' "log directory linked or read out"
f57 'tee -a "$slog/run.log" < x' "log directory linked or read out"
f57 'head -50 "$slog/run.log"' "log directory linked or read out"
f57 'tail "$slog/run.log"' "log directory linked or read out"
f57 'printf -v slog %s /dev' "log directory written other than by a plain assignment"
f57 ': "${slog:=/dev}"' "log directory written other than by a plain assignment"
f57 'for slog in /dev; do :; done' "log directory written other than by a plain assignment"
f57 'read -r slog < x' "log directory written other than by a plain assignment"
f57 'declare slog=/dev' "log directory"
mkfx "$T/fx57"; python3 - "$T/fx57/.github/workflows/data-scan.yml" <<'PY'
import sys
p = sys.argv[1]; s = open(p).read(); i = s.index("\n  assemble:"); j = s.index("    steps:\n", i) + len("    steps:\n")
open(p, "w").write(s[:j] + "      - run: echo x\n        env:\n          ZS: zeroed-scan\n" + s[j:])
PY
ACFX=$T/fx57/research/historical/ci ac env AC_STATUS=206; [[ ! -e "$A/curl.calls" ]] && grep -q "env ZS names a scanner binary" "$A/summary.md" || bad+=" [workflow-env]"
[[ -z "$bad" ]] && ok "OF-2 r8 ruling 57 (OF-3 26): arming refuses ln, cat, tee, head and tail on the log directories, printf -v, :=, for, read and declare writes to them, and a scanner binary named in a workflow env" || no "OF-2 r8 log directory writes:$bad"
bad=""; gdreset; touch "$GD/noguard-$NG"
# 59. Archive workflows run on a pinned image.
python3 - "$here/../../../.github/workflows/data-scan.yml" "$here/../../../.github/workflows/archive-check.yml" <<'PY' || bad+=" pinned"
import sys, yaml
for f in sys.argv[1:]:
    for j, job in yaml.safe_load(open(f))["jobs"].items():
        assert job["runs-on"] == "ubuntu-24.04", (f, j, job["runs-on"])
PY
mkfx "$T/fx59"; sed -i '0,/runs-on: ubuntu-24.04/s//runs-on: ubuntu-latest/' "$T/fx59/.github/workflows/data-scan.yml"
ACFX=$T/fx59/research/historical/ci ac env AC_STATUS=206; [[ ! -e "$A/curl.calls" ]] && grep -q "runs on ubuntu-latest, not a pinned ubuntu-NN.NN image" "$A/summary.md" || bad+=" arm-latest"
[[ -z "$bad" ]] && ok "OF-2 r8 ruling 59: every job of data-scan.yml and archive-check.yml runs on ubuntu-24.04, and arming refuses an archive workflow on ubuntu-latest" || no "OF-2 r8 runner image:$bad"
bad=""; gdreset
# OF-3 27. When the full save is skipped or fails, the logs alone are sealed and saved.
python3 - "$here/../../../.github/workflows/data-scan.yml" <<'PY' || bad+=" workflow"
import sys, yaml
steps = yaml.safe_load(open(sys.argv[1]))["jobs"]["scan"]["steps"]
ids = [s.get("id") or s.get("name") for s in steps]
sl, sv = steps[ids.index("seallogs")], steps[ids.index("Save the logs alone")]
assert "steps.save.outcome != 'success'" in sl["if"] and sl["if"].startswith("always()") and 'cache-crypt.sh" seal "$RUNNER_TEMP/work/data/logs" "$RUNNER_TEMP/work/sealed-logs" "$PREFIX"' in sl["run"], sl
assert sv["with"]["path"] == "${{ runner.temp }}/work/sealed-logs" and sv["with"]["key"].endswith("-logs") and "-k${{ steps.cachekid.outputs.kid }}-" in sv["with"]["key"] and "steps.seallogs.outcome == 'success'" in sv["if"], sv
assert ids.index("seallogs") > ids.index("save"), ids
PY
lg="$T/lg"; rm -rf "$lg"; mkdir -p "$lg/data/logs" "$lg/data/units/1/2"; echo "run reason curve=5" > "$lg/data/logs/run.log"; echo unit > "$lg/data/units/1/2/a.zst"
DATA_STORE_TOKEN=tlg bash "$here/cache-crypt.sh" seal "$lg/data/logs" "$lg/sealed-logs" data-scan-2026-07-22- logs >/dev/null 2>&1 && ! grep -rq "curve=5" "$lg/sealed-logs" &&
  DATA_STORE_TOKEN=tlg bash "$here/cache-crypt.sh" open "$lg/sealed-logs" "$lg/o" data-scan-2026-07-22- logs >/dev/null 2>&1 && grep -q "curve=5" "$lg/o/run.log" && [[ ! -e "$lg/o/units" ]] || bad+=" logs-only"
printf '{"actions_caches": [{"key": "data-scan-2026-07-22-k0123456789ab-5-1-logs", "size_in_bytes": 9, "created_at": "2026-10-05T03:00:00Z", "ref": "refs/heads/ccr-x"}, {"key": "data-scan-2026-07-22-k0123456789ab-4-1", "size_in_bytes": 5, "created_at": "2026-10-05T01:00:00Z", "ref": "refs/heads/ccr-x"}]}' > "$PP/caches.json"
pp data-scan-2026-07-22- >/dev/null && grep -qx "key=data-scan-2026-07-22-k0123456789ab-4-1" "$PP/out" || bad+=" pick-ignores-logs"
[[ -z "$bad" ]] && ok "OF-3 r8 ruling 27: when the full save is skipped or fails, the logs alone are sealed (no units, no plaintext) and saved as PREFIXk<id>-RUN-ATTEMPT-logs from work/sealed-logs; progress-pick never resumes from a -logs entry" || no "OF-3 r8 logs-only save:$bad"
bad=""

# ---- OF-3 ruling 25: a trim failure keeps its logs, sealed alone; half-trimmed units are never sealed ----
bad=""
python3 - "$here/../../../.github/workflows/data-scan.yml" <<'PY' || bad+=" workflow"
import sys, yaml
steps = yaml.safe_load(open(sys.argv[1]))["jobs"]["scan"]["steps"]
ids = [s.get("id") or s.get("name") for s in steps]
for k in ("seallogs", "Save the logs alone"):
    assert "steps.trim.outcome == 'failure'" in steps[ids.index(k)]["if"], k
assert ids.index("seallogs") > ids.index("trim"), ids
for k in ("sealqa", "Save progress after QA"):
    assert "steps.trim.outcome" not in steps[ids.index(k)]["if"], k
PY
mkk2; rc=0; TRIM_FAIL_ON=3-4 td 2026-07-22 - || rc=$?
rm -rf "$T/r25s" "$T/r25o"; DATA_STORE_TOKEN=t25 bash "$here/cache-crypt.sh" seal "$T/tk2/logs" "$T/r25s" data-scan-2026-07-22- logs >/dev/null 2>&1 &&
  DATA_STORE_TOKEN=t25 bash "$here/cache-crypt.sh" open "$T/r25s" "$T/r25o" data-scan-2026-07-22- logs >/dev/null 2>&1 &&
  [[ $rc != 0 && -f "$T/r25o/trim.log" && ! -e "$T/r25o/units" && ! -e "$T/r25o/units.k3" ]] || bad+=" logs-only:$rc"
[[ -z "$bad" ]] && ok "OF-3 ruling 25: after a forced trim failure the logs alone are sealed (trim.log inside, no units or units.k3), by the logs steps that also run on a trim failure; the QA saves never run then" || no "OF-3 trim-failure logs:$bad"
# ---- OF-3 round 9, rulings 28 and 29 ----
bad=""; wf="$here/../../../.github/workflows/data-scan.yml"
# 28. A logs entry is sealed as type logs; open (a resume, progress only) refuses it. With no
# picked progress the restore key ends in a suffix no saved key can start with, so a re-run
# whose only entry is a -logs one restores nothing and starts clean.
c28="$T/c28"; rm -rf "$c28"; mkdir -p "$c28/data/logs"; echo "curve=5" > "$c28/data/logs/run.log"
DATA_STORE_TOKEN=t28 bash "$here/cache-crypt.sh" seal "$c28/data/logs" "$c28/sealed" data-scan-2026-07-22- logs >/dev/null 2>&1 || bad+=" seal"
rc=0; DATA_STORE_TOKEN=t28 bash "$here/cache-crypt.sh" open "$c28/sealed" "$c28/o" data-scan-2026-07-22- 2>/dev/null >/dev/null || rc=$?
[[ $rc == 2 && ! -e "$c28/o" && -f "$c28/sealed/progress.enc" ]] || bad+=" logs-opened-as-progress:$rc"
rc=0; DATA_STORE_TOKEN=t28 bash "$here/cache-crypt.sh" seal "$c28/data/logs" "$c28/s2" data-scan-2026-07-22- units >/dev/null 2>&1 || rc=$?; [[ $rc == 2 ]] || bad+=" bad-type:$rc"
python3 - "$wf" <<'PY' || bad+=" restore-key"
import re, sys, yaml
steps = yaml.safe_load(open(sys.argv[1]))["jobs"]["scan"]["steps"]
by = {(s.get("id") or s.get("name")): s for s in steps}
def render(key, src="data-scan", day="2026-07-22", kid="0123456789ab", run="777", attempt="1", pick=""):
    if pick: return pick
    m = re.search(r"format\('([^']*)'", key); f = m.group(1)
    return f.replace("{0}", src).replace("{1}", day).replace("{2}", kid).replace("{3}", run)
def saved(key, **kw):
    k = key.replace("${{ inputs.source == 'helius' && 'data-rpc' || 'data-scan' }}", "data-scan")
    return (k.replace("${{ matrix.day }}", "2026-07-22").replace("${{ steps.cachekid.outputs.kid }}", "0123456789ab")
             .replace("${{ github.run_id }}", "777").replace("${{ github.run_attempt }}", "1"))
r = by["restore"]["with"]; assert "restore-keys" not in r, r
fallback = render(r["key"])
entries = [saved(s["with"]["key"]) for s in steps if str(s.get("uses", "")).startswith("actions/cache/save") and "data-scan" in s["with"]["key"]]
logs = [e for e in entries if e.endswith("-logs")]; assert logs == ["data-scan-2026-07-22-k0123456789ab-777-1-logs"], entries
# the cache matches the key exactly or as a prefix of a saved key; with only the -logs entry, nothing
assert not [e for e in logs if e == fallback or e.startswith(fallback)], (fallback, logs)
assert not [e for e in entries if e.startswith(fallback)], (fallback, entries)
assert '"$PREFIX" logs' in by["seallogs"]["run"] and '"$PREFIX" logs' not in by["seal"]["run"] and '"$PREFIX" logs' not in by["sealqa"]["run"], "types"
PY
# 29. The logs are sealed and saved alone whenever the job has failed, even when the full
# save "succeeded" (over the cache limit it stores nothing and only warns); a clean run whose
# save succeeded makes no logs entry.
python3 - "$wf" <<'PY' || bad+=" failure-logs"
import re, sys, yaml
steps = yaml.safe_load(open(sys.argv[1]))["jobs"]["scan"]["steps"]
by = {(s.get("id") or s.get("name")): s for s in steps}
def ev(expr, failed, out):
    e = expr.replace("&&", " and ").replace("||", " or ").replace("always()", "True").replace("failure()", str(failed))
    e = re.sub(r"steps\.(\w+)\.(outcome|outputs\.\w+)", lambda m: repr(out.get(m.group(1) + "." + m.group(2), "")), e)
    e = re.sub(r"inputs\.source", repr("archive"), e)
    return eval(e)
base = {"published.outcome": "success", "published.outputs.complete": "false", "save.outcome": "success", "trim.outcome": "success", "seallogs.outcome": "success"}
for k in ("seallogs", "Save the logs alone"):
    assert ev(by[k]["if"], True, base), (k, "failed job, save succeeded")
    assert not ev(by[k]["if"], False, base), (k, "clean run")
    assert ev(by[k]["if"], False, dict(base, **{"save.outcome": "skipped"})), (k, "save skipped")
PY
[[ -z "$bad" ]] && ok "OF-3 rulings 28 and 29: a logs entry is sealed as type logs and a resume (progress) refuses it; with no picked progress the restore key matches no saved entry, so a re-run with only a -logs entry restores nothing and starts clean; the logs are sealed and saved alone whenever the job failed, even after a save that \"succeeded\"" || no "OF-3 r9 logs entries:$bad"
bad=""
# ---- OF-2 round 9 (docs/reviews/OF2.md rulings 63-66) ----
gdreset; bad=""; now=$(date -u +%s); touch "$GD/noguard-$NG"
# 63. The log directories are named only as a write target, to mkdir or rm, in their assignment, or to the seal.
f63() { mkfx "$T/fx63"; c="$T/fx63/research/historical/ci"; printf '%s\n' "$1" >> "$c/scan-day.sh"
  ACFX=$c ac env AC_STATUS=206; [[ ! -e "$A/curl.calls" ]] && grep -q "scan-day.sh line [0-9]* prints scanner or QA output to the job log: log directory named other than as a write target" "$A/summary.md" || bad+=" [$1]"; }
f63 'grep curve "$slog/run.log"'
f63 'sed -n 1p "$slog/run.log"'
f63 'cp "$slog/run.log" "$GITHUB_STEP_SUMMARY"'
f63 'while read -r l; do echo "$l"; done < "$slog/run.log"'
f63 'wc -l "$out/logs/run.log"'
mkfx "$T/fx63"; c="$T/fx63/research/historical/ci"; printf '%s\n' 'echo done >> "$slog/note.log"' 'rm -rf "$slog/old"' >> "$c/scan-day.sh"
ACFX=$c ac env AC_STATUS=206; [[ $(wc -l < "$A/curl.calls" 2>/dev/null) == 1 ]] || bad+=" write-target-ok:$(cat "$A/summary.md")"
[[ -z "$bad" ]] && ok "OF-2 r9 ruling 63: arming refuses a log directory named by grep, sed, cp to the step summary, a while-read input redirect, or a full .../logs/ path; appending to it and rm on it are accepted" || no "OF-2 r9 log reads:$bad"
bad=""; gdreset; touch "$GD/noguard-$NG"
# 64. The status queries run before the created slices.
guard full 2026-07-22 || bad+=" guard"
fs=$(grep -n "workflows/data-scan.yml/runs?status=" "$GD/gh.log" | head -1 | cut -d: -f1); fc=$(grep -n "workflows/data-scan.yml/runs?created=" "$GD/gh.log" | head -1 | cut -d: -f1)
[[ -n "$fs" && -n "$fc" ]] && (( fs < fc )) || bad+=" order:$fs/$fc"
[[ -z "$bad" ]] && ok "OF-2 r9 ruling 64: the run history asks for every non-completed status before the created slices" || no "OF-2 r9 query order:$bad"
bad=""; gdreset; touch "$GD/noguard-$NG"
# 65. No job container, service containers or reusable workflow in an archive workflow.
for v in container services uses; do
  mkfx "$T/fx65"; python3 - "$T/fx65/.github/workflows/data-scan.yml" "$v" <<'PY'
import sys
p, v = sys.argv[1], sys.argv[2]; s = open(p).read(); i = s.index("\n  assemble:"); j = s.index("\n    runs-on:", i)
add = {"container": "\n    container: ubuntu:24.04", "services": "\n    services:\n      db:\n        image: postgres:16", "uses": "\n    uses: ./.github/workflows/other.yml"}[v]
open(p, "w").write(s[:j] + add + s[j:])
PY
  ACFX=$T/fx65/research/historical/ci ac env AC_STATUS=206; [[ ! -e "$A/curl.calls" ]] && grep -q "data-scan.yml job assemble uses $v:" "$A/summary.md" || bad+=" [$v]"
done
[[ -z "$bad" ]] && ok "OF-2 r9 ruling 65: arming refuses an archive job with a container, service containers or a reusable workflow" || no "OF-2 r9 job kinds:$bad"
# ---- OF-3 round 9, ruling 30 (replaces OF-2 63's deny-list): the log directories only by an allow-list; no eval ----
bad=""
c30() { # c30 accept|refuse LINE: the checker's verdict on one line of a CI script
  local got; got=$( (. "$here/archive-limits.conf"; . "$here/archive-guard.sh"; printf '%s\n' "$2" | python3 -c "$ag_calls_py") >/dev/null 2>&1 && echo accept || echo refuse)
  [[ $got == "$1" ]] || bad+=" [$1: $2]"; }
c30 refuse 'cp "$slog/run.log" /dev/stdout'
c30 refuse 'sed -n p "$slog/run.log"'
c30 refuse 'awk 1 "$slog/run.log"'
c30 refuse 'grep . "$slog/run.log"'
c30 refuse 'while read -r l; do echo "$l"; done < "$slog/run.log"'
c30 refuse 'cp -s "$slog/run.log" "$RUNNER_TEMP/x"'
c30 refuse 'eval "x=1"'
c30 refuse 'cd "$slog"'
c30 refuse 'x="$slog"; cat "$x/run.log"'
c30 refuse 'export slog'
c30 refuse 'local -n r=slog'
c30 refuse 'for slog in "$out"/logs; do :; done'
c30 refuse 'read -r slog < "$RUNNER_TEMP/p"'
c30 refuse 'printf -v slog %s "$out/logs"'
c30 refuse ': "${slog:=$out/logs}"'
c30 refuse 'ln -sf "$slog/run.log" "$RUNNER_TEMP/x"'
c30 refuse 'cat "$slog/run.log"'
c30 refuse 'cat <<< "$slog"'
c30 refuse 'exec 3< "$slog/run.log"'
c30 refuse 'exec 3<> "$slog/run.log"'
c30 refuse 'slog="$out/logs" cat "$slog/run.log"'
c30 refuse 'echo "$(cat "$slog/run.log")" >> "$GITHUB_STEP_SUMMARY"'
c30 refuse 'echo "$(<"$slog/run.log")" >> "$GITHUB_STEP_SUMMARY"'
c30 refuse 'echo "logs: $slog" > /dev/stdout'
c30 refuse 'mv "$tlog/migrations.list" "$GITHUB_STEP_SUMMARY"'
c30 refuse 'mv "$tlog/run.log" "$RUNNER_TEMP/x"'
c30 refuse 'bash cache-crypt.sh seal "$slog" "$RUNNER_TEMP/s" "$P"'
c30 accept 'slog="$out/logs"; mkdir -p "$slog"'
c30 accept 'qlog="${RUNNER_TEMP:?}/volume-log-$day"; rm -rf "$qlog"; mkdir -p "$qlog"'
c30 accept 'zeroed-scan unit -out "$out" >> "$slog/run.log" 2>&1'
c30 accept 'lst=$(zeroed-scan migrations -day-start "$dstart" "$out" 2>> "$tlog/migrations.log")'
c30 accept 'mv "$tlog/migrations.list" "$list.tmp"'
c30 accept 'echo "logs kept in $slog" >> "$GITHUB_STEP_SUMMARY"'
c30 accept 'bash cache-crypt.sh seal "$RUNNER_TEMP/work/data/logs" "$RUNNER_TEMP/s" "$P"'
mkfx "$T/fx30"; c="$T/fx30/research/historical/ci"; printf '%s\n' 'eval "$1"' >> "$c/scan-day.sh"
ACFX=$c ac env AC_STATUS=206; [[ ! -e "$A/curl.calls" ]] && grep -q "scan-day.sh line [0-9]* prints scanner or QA output to the job log: eval in a CI script" "$A/summary.md" || bad+=" [arming eval]"
[[ -z "$bad" ]] && ok "OF-3 ruling 30: a line naming qlog, slog or tlog may only assign it under \$out or \$RUNNER_TEMP, mkdir or rm it, redirect output into it, mv migrations.list out of it, or echo it to the summary (each red-team form refused: cp to /dev/stdout, sed, awk, grep, while read <, cp -s, eval, cd, aliasing, for, read, printf -v, :=, ln, cat, <<<, exec <, env prefix, \$(cat), \$(<), mv elsewhere); arming refuses eval" || no "OF-3 r9 log allow-list:$bad"
# ---- OF-2 round 10, ruling 67: a logs path after any spelling of $out or $RUNNER_TEMP; no read of $out itself or after a cd into it ----
bad=""
c30 refuse 'cat "${out}/logs/run.log"'
c30 refuse 'cat "$out"/logs/run.log'
c30 refuse 'cd "$out" && cat logs/run.log'
c30 refuse 'find "$out" -name run.log -exec cat {} +'
c30 refuse 'cat "$RUNNER_TEMP"/work/data/logs/run.log'
c30 refuse 'cat "${RUNNER_TEMP}/work/data/logs/run.log"'
c30 refuse 'grep -r curve "$out"'
c30 refuse 'cp -r "$out/" "$RUNNER_TEMP/pub"'
c30 refuse 'cat "$out"/*/run.log'
c30 refuse 'find "$out" -type f | xargs cat'
c30 refuse 'cd "$out" && find . -exec cat {} +'
c30 refuse $'cd "$out"\ncat logs/run.log'
c30 accept '(cd "$out" && find units -mindepth 3 -name x | LC_ALL=C sort)'
c30 accept '(cd "$out/units" && sha256sum -- "$epoch/$range"/*.zst)'
c30 accept 'cp "$out"/cache/* "$again/cache/"'
c30 accept 'find "$out" -name x'
[[ -z "$bad" ]] && ok "OF-2 ruling 67: arming refuses a logs path after a braced or quoted \$out or \$RUNNER_TEMP, a cd into \$out then a read (same line or later), find -exec or xargs on \$out, and grep, cp or a top-level glob on \$out itself; cd into a subdirectory, find listing names and a glob below the top level are accepted" || no "OF-2 r10 out spellings:$bad"
# ---- OF-2 round 10, ruling 70: a read command with a logs path part, whatever variable precedes it ----
bad=""
c30 refuse 'd="$out"; cat "$d/logs/run.log"'
c30 refuse 'r="$RUNNER_TEMP"; tar -cf - "$r/work/data/logs" | base64'
c30 refuse 'w="$RUNNER_TEMP/work"; grep curve "$w"/data/logs/run.log'
c30 refuse 'ls "$d/logs" | xargs -I{} cat "$d/logs/{}"'
c30 accept 'du -sh "$out/units"'
c30 accept 'find units -mindepth 3 -name stats.json | wc -l'
c30 accept 'ls units'
c30 accept 'mkdir -p "$again/cache"'
c30 accept 'cp "$out"/cache/* "$again/cache/"'
c30 accept 'echo "logs kept in $slog" >> "$GITHUB_STEP_SUMMARY"'
c30 accept '(cd "$out" && tar --exclude="*.tmp" --remove-files -cf - units) | split -b 1900m -d -a 2 - "$assets/units.tar.part"'
[[ -z "$bad" ]] && ok "OF-2 ruling 70: a read command (cat, grep, tar, xargs, ...) with a logs path part is refused whatever variable comes first (an alias of \$out or \$RUNNER_TEMP); du, find -name | wc, ls units, mkdir, cp of the cache, an echo to the summary and tar of units stay accepted" || no "OF-2 r10 logs part:$bad"
bad=""
bad=""
bad=""
bad=""; gdreset

# ---- OF-4: nothing public; the private store; read-back; the storage stop after every batch ----
bad=""; wf="$here/../../../.github/workflows"
# Every release call any script made in this suite named the private store, never this repository.
[[ -s "$T/ghrepo.log" ]] && ! grep -v ' repo=test/data ' "$T/ghrepo.log" >/dev/null || bad+=" [calls: $(grep -v ' repo=test/data ' "$T/ghrepo.log" | head -2 | tr '\n' ' ')]"
# Each script refuses before any gh call without the private store, or when it is this repository.
printf '#!/usr/bin/env bash\necho "$*" >> "%s/ghcalls4.log"\nexit 1\n' "$T" > "$T/ghrec4"; chmod +x "$T/ghrec4"
mkpd
for dr in "" test/repo TEST/Repo; do
  : > "$T/ghcalls4.log"
  DATA_REPO="$dr" GH_BIN="$T/ghrec4" bash "$here/publish-day.sh" 2026-09-30 "$pd" >/dev/null 2>&1 && bad+=" [publish-day '$dr']"
  DATA_REPO="$dr" GH_BIN="$T/ghrec4" bash "$here/publish-day.sh" --check 2026-09-30 >/dev/null 2>&1 && bad+=" [check '$dr']"
  DATA_REPO="$dr" GH_BIN="$T/ghrec4" bash "$here/publish-volume.sh" 2026-09-30 "$vd/assets" >/dev/null 2>&1 && bad+=" [publish-volume '$dr']"
  DATA_REPO="$dr" GH_BIN="$T/ghrec4" bash "$here/storage-check.sh" >/dev/null 2>&1 && bad+=" [storage-check '$dr']"
  [[ ! -s "$T/ghcalls4.log" ]] || bad+=" [gh called with '$dr']"
done
DATA_REPO="" PATH="$T/bin:$PATH" bash "$here/volume-day.sh" --download 2026-09-30 "$T/v4" >/dev/null 2>&1 && bad+=" [volume-day download]"
for m in --download --store; do
  out=$(DATA_REPO=test/repo bash "$here/assemble.sh" $m 2026-09-20 2026-09-21 "$T/as4" 2>&1) && bad+=" [assemble $m]"
  [[ "$out" == *"not the private store"* ]] || bad+=" [assemble $m msg: ${out:0:80}]"
done
[[ -z "$bad" ]] && ok "OF-4: every release call in this suite named the private store (DATA_REPO); publish-day (and --check), publish-volume, storage-check, volume-day --download and assemble refuse before any gh call without DATA_REPO or when it is this repository" || no "OF-4 private store only:$bad"
bad=""
# The day release carries the per-unit log, and the OF-3 files SHA256SUMS lists.
export GH_BIN="$T/bin/gh"
rm -rf "$T/rel/data-day-2026-09-30"; mkpd; echo "k2 abc u" > "$pd/rescan-2026-09-30.sha256"; echo "pool 1 2" > "$pd/list-2026-09-30.txt"
(cd "$pd" && sha256sum units-* events-* qa-* manifest-* parity-* rescan-* list-* > SHA256SUMS-2026-09-30)
: > "$T/ghout4"; GITHUB_OUTPUT="$T/ghout4" bash "$here/publish-day.sh" 2026-09-30 "$pd" >/dev/null 2>&1 &&
  for f in units-2026-09-30.log rescan-2026-09-30.sha256 list-2026-09-30.txt; do [[ -f "$T/rel/data-day-2026-09-30/$f" ]] || bad+=" [no $f]"; done || bad+=" [store]"
grep -qx readback=true "$T/ghout4" || bad+=" [no readback=true]"
GITHUB_OUTPUT=/dev/null bash "$here/publish-day.sh" 2026-09-30 "$pd" >/dev/null 2>&1 || bad+=" [complete rerun]"
rm -rf "$T/rel/data-day-2026-09-30"; mkpd; rm "$pd/units-2026-09-30.log"; (cd "$pd" && sha256sum units-* events-* qa-* manifest-* parity-* > SHA256SUMS-2026-09-30)
out=$(bash "$here/publish-day.sh" 2026-09-30 "$pd" 2>&1) && bad+=" [stored without the per-unit log]"
[[ "$out" == *"missing units-2026-09-30.log"* && ! -d "$T/rel/data-day-2026-09-30" ]] || bad+=" [log msg: ${out:0:80}]"
[[ -z "$bad" ]] && ok "OF-4: the day release carries the per-unit log (and the rescan hashes and list when SHA256SUMS lists them), is read back (readback=true), and a day without its per-unit log is not stored" || no "OF-4 per-unit log:$bad"
bad=""
# A read-back mismatch fails the step (no readback=true), on a fresh store and on a complete rerun.
for c in units-2026-09-30.tar.part01 units-2026-09-30.log SHA256SUMS-2026-09-30; do
  rm -rf "$T/rel/data-day-2026-09-30"; mkpd; : > "$T/ghout4"
  out=$(FAKE_GH_CORRUPT=$c GITHUB_OUTPUT="$T/ghout4" bash "$here/publish-day.sh" 2026-09-30 "$pd" 2>&1) && bad+=" [$c passed]"
  [[ "$out" == *"read-back"* && ! -s "$T/ghout4" ]] || bad+=" [$c: ${out:0:80}]"
done
out=$(FAKE_GH_CORRUPT=units-2026-09-30.tar.part00 GITHUB_OUTPUT="$T/ghout4" bash "$here/publish-day.sh" 2026-09-30 "$pd" 2>&1) && bad+=" [rerun passed]"
rm -rf "$T/rel/data-volume-2026-09-30"
out=$(FAKE_GH_CORRUPT=volume-hours-2026-09-30.csv bash "$here/publish-volume.sh" 2026-09-30 "$vd/assets" 2>&1) && bad+=" [volume passed]"
[[ "$out" == *"read-back"* ]] || bad+=" [volume: ${out:0:80}]"
unset GH_BIN
[[ -z "$bad" ]] && ok "OF-4: a read-back mismatch (a part, the per-unit log or SHA256SUMS; also on a rerun of a complete release; and the volume CSV) fails the store step without readback=true, so the progress cache is kept" || no "OF-4 read-back:$bad"
bad=""
# The workflows: nothing public, the store token only in clean steps, the storage check after each batch.
python3 - "$wf/data-scan.yml" "$wf/archive-check.yml" <<'PY' || bad+=" [workflow]"
import sys, yaml
ds = yaml.safe_load(open(sys.argv[1])); jobs = ds["jobs"]
for j, job in jobs.items():
    perms = job.get("permissions") or {}
    assert perms.get("contents") != "write" and perms != "write-all", j
    for st in job.get("steps") or []:
        u = str(st.get("uses", ""))
        if u.startswith("actions/upload-artifact"):
            assert j == "scan" and str(st["with"]["name"]).startswith("resume-"), (j, st)
        assert st.get("name") != "Publish this day", st
        run = str(st.get("run", "")); env = st.get("env") or {}
        if any(k in run for k in ("publish-day.sh", "publish-volume.sh", "storage-check.sh", "volume-day.sh\" --download")):
            assert env.get("GH_TOKEN") == "${{ secrets.DATA_STORE_TOKEN }}" and env.get("DATA_REPO") == "${{ vars.DATA_REPO }}", st
            assert st["shell"].startswith("/usr/bin/env -u BASH_ENV -u ENV /usr/bin/bash --noprofile --norc") and run.startswith("/usr/bin/env -i PATH=/usr/bin:/bin "), st
        if "DATA_STORE_TOKEN" in str(env):
            assert run.startswith("/usr/bin/env -i PATH=/usr/bin:/bin "), st
# OF-4 ruling 5: assemble downloads and stores in clean steps; the build holds no token
asm = {x.get("name"): x for x in jobs["assemble"]["steps"]}
for k, m in (("Download the days from the private store", "--download"), ("Store the dataset in the private store", "--store")):
    assert asm[k]["env"]["GH_TOKEN"] == "${{ secrets.DATA_STORE_TOKEN }}" and asm[k]["run"].startswith("/usr/bin/env -i PATH=/usr/bin:/bin ") and ('assemble.sh" ' + m + ' "$FROM" "$TO" /mnt/work') in asm[k]["run"], asm[k]
b = asm["Assemble the dataset"]; assert "TOKEN" not in str(b.get("env")) and b["run"] == 'research/historical/ci/assemble.sh "$FROM" "$TO" /mnt/work', b
names = list(asm); assert names.index("Download the days from the private store") < names.index("Assemble the dataset") < names.index("Store the dataset in the private store"), names
steps = jobs["scan"]["steps"]; names = [s.get("id") or s.get("name") for s in steps]
assert "Store this day's volume hours" in names and names.index("store") < names.index("Store this day's volume hours") < names.index("Storage check after the batch"), names
sc = steps[names.index("Storage check after the batch")]
# OF-5 ruling 5: the check runs whenever the day was stored, also when a later step failed.
# GitHub adds success() to an if without a status function, so model that.
def runs(cond, **v):
    import re as _re
    if not _re.search(r"\b(success|failure|always|cancelled)\(\)", cond): cond = "success() && " + cond
    e = cond.replace("!cancelled()", str(not v["cancelled"])).replace("success()", str(not v["failed"] and not v["cancelled"]))
    e = e.replace("failure()", str(v["failed"])).replace("always()", "True").replace("cancelled()", str(v["cancelled"]))
    e = e.replace("steps.published.outputs.complete", repr(v["complete"])).replace("steps.store.outcome", repr(v["store"]))
    e = e.replace("steps.store.outputs.readback", repr(v["readback"])).replace("inputs.source", repr(v["source"]))
    e = e.replace("&&", " and ").replace("||", " or ")
    return eval(e, {})
base = dict(cancelled=False, failed=False, complete="", store="success", readback="true", source="archive")
cases = [(dict(), True), (dict(failed=True), True), (dict(failed=True, store="failure", readback=""), True),
         (dict(store="skipped", readback="", complete="true"), False), (dict(cancelled=True, failed=True), False),
         (dict(source="helius", store="skipped", readback=""), False)]
for c, want in cases:
    got = runs(sc["if"], **{**base, **c})
    assert got == want, ("storage check", c, got)
head = open(sys.argv[1]).read().split("\nname:")[0]
assert "contents: write for this" not in head and "private store" in head, "header"
ac = yaml.safe_load(open(sys.argv[2]))
hold = next(s for j in ac["jobs"].values() for s in j["steps"] if s.get("name") == "Holds")
assert hold["shell"].startswith("/usr/bin/env -u BASH_ENV -u ENV /usr/bin/bash --noprofile --norc") and hold["run"].startswith("/usr/bin/env -i PATH=/usr/bin:/bin "), hold
assert all(hold["env"].get(k) == "" for k in ("BASH_ENV", "LD_PRELOAD", "LD_AUDIT", "LD_LIBRARY_PATH")) and "archive-check.sh" in hold["run"], hold
PY
# The guard's own private-storage check passes on this tree (it refused while anything was public).
(cd "$here" && . ./archive-limits.conf && . ./archive-guard.sh && ag_summary=/dev/null && ag_private_storage) >/dev/null 2>&1 || bad+=" [ag_private_storage refuses]"
[[ -z "$bad" ]] && ok "OF-4: no data-scan job has contents: write, the only artifact is resume-, no 'Publish this day' step; every store, skip, volume and storage-check step holds the store token only under env -i; the storage check follows each stored day, also when a later step failed (OF-5 ruling 5), never after a cancel; archive-check's Holds step runs under env -i; the guard's ag_private_storage passes on this tree" || no "OF-4 workflows:$bad"
bad=""
# The storage stop after every batch, against a fake private store.
cat > "$T/storegh" <<'EOF'
#!/usr/bin/env bash
# a fake private store: $T/store/<tag>/ files; .draft marks a draft; .bytes is the rest of the
# release's size; .sizes holds "NAME BYTES" lines for named assets (they add to the total)
set -euo pipefail
S="$T/store"; mkdir -p "$S"
case "$1" in
  api)
    shift; [[ "$1" == --paginate ]] && shift; path=$1; shift; q="."
    while (( $# )); do [[ "$1" == --jq ]] && q=$2; shift; done
    case "$path" in
      repos/test/data) echo '{"private":true}' | jq -r "$q" ;;
      repos/test/data/releases\?*)
        for d in "$S"/*/; do [ -d "$d" ] || continue
          t=$(basename "$d"); dr=false; [ -e "$d/.draft" ] && dr=true; b=$(cat "$d/.bytes" 2>/dev/null || echo 0)
          sz=$( { cat "$d/.sizes" 2>/dev/null || true; } | jq -R 'split(" ") | {(.[0]): (.[1] | tonumber)}' | jq -s 'add // {}')
          (cd "$d" && ls) | jq -R . | jq -s --arg t "$t" --argjson dr "$dr" --argjson b "$b" --argjson sz "$sz" \
            '{tag_name: $t, draft: $dr, assets: ([.[] | {name: ., size: ($sz[.] // 0)}] + [{name: ".bulk", size: $b}])}'
        done | jq -s . | jq -r "$q" ;;
      repos/test/data/git/matching-refs/tags/storage-stop)
        if [ -d "$S/storage-stop" ] && [ ! -e "$S/storage-stop/.draft" ]; then echo '[{"ref":"refs/tags/storage-stop"}]'; else echo '[]'; fi | jq -r "$q" ;;
      *) echo "HTTP 404" >&2; exit 1 ;;
    esac ;;
  release)
    cmd=$2 tag=$3; shift 3; repo=""; out=""; pats=()
    while (( $# )); do case "$1" in --repo) repo=$2; shift ;; --dir) out=$2; shift ;; --pattern) pats+=("$2"); shift ;; esac; shift; done
    [[ "$repo" == test/data ]] || exit 9
    case "$cmd" in
      create) mkdir "$S/$tag"; echo "$tag" >> "$T/storecreated.log" ;;
      download) for p in "${pats[@]}"; do cp "$S/$tag"/$p "$out/"; done ;;
      *) exit 2 ;;
    esac ;;
esac
EOF
chmod +x "$T/storegh"
# mkday TAG BYTES [SUBSET [EVENTS]]: a day release of BYTES in all; a K2 one (SUBSET given) also
# carries pm01-subset-DAY.txt and an events-DAY.tar of EVENTS bytes (default 1 GB) within BYTES
mkday() { local d=${1#data-day-} ev=${4:-1000000000}; mkdir -p "$T/store/$1"
  if [[ -z "${3:-}" ]]; then echo "$2" > "$T/store/$1/.bytes"; return; fi
  echo "$3" > "$T/store/$1/pm01-subset-$d.txt"; : > "$T/store/$1/events-$d.tar"
  echo "events-$d.tar $ev" > "$T/store/$1/.sizes"; echo $(( $2 - ev )) > "$T/store/$1/.bytes"; }
sck() { : > "$T/sck.sum"; rc=0; GH_BIN="$T/storegh" GITHUB_STEP_SUMMARY="$T/sck.sum" bash "$here/storage-check.sh" > "$T/sck.out" 2>&1 || rc=$?; }
# After batch 5: 31 days, 5 stored, 26 left. Stored 75 GB (two K2 days 40 + 35 with 5 GB subsets) + 3 x 15 GB
# K3 days = 120 GB; + 26 x 15 GB = 510 GB (0.51 TB) -> the marker and exit 3.
rm -rf "$T/store"; : > "$T/storecreated.log"
mkday data-day-2026-07-22 40000000000 5000000000; mkday data-day-2026-07-23 35000000000 5000000000
for d in 24 25 26; do mkday data-day-2026-07-$d 15000000000; done; mkday data-volume-2026-07-22 0
sck; [[ $rc == 3 && -d "$T/store/storage-stop" && ! -e "$T/store/storage-stop/.draft" ]] && grep -q "= 510000000000 bytes" "$T/sck.sum" || bad+=" [0.51: $rc $(head -c 200 "$T/sck.out")]"
# the stop from both sides: the marker it wrote is the one the guard refuses on
(DATA_REPO=test/data DATA_STORE_TOKEN=x GH_REPO=test/repo GH_BIN="$T/storegh"; . "$here/archive-guard.sh"; ag_summary=/dev/null; ag_store_ok) >/dev/null 2>&1 && bad+=" [guard passed with the marker]"
sck; [[ $rc == 3 && $(grep -c storage-stop "$T/storecreated.log") == 1 ]] || bad+=" [marker rewritten or not refused: $rc]"
# Same day sizes with the K2 days at 30 + 25 GB: 100 GB + 390 GB = 490 GB (0.49 TB) -> no marker, exit 0.
rm -rf "$T/store"; : > "$T/storecreated.log"
mkday data-day-2026-07-22 30000000000 5000000000; mkday data-day-2026-07-23 25000000000 5000000000
for d in 24 25 26; do mkday data-day-2026-07-$d 15000000000; done
sck; [[ $rc == 0 && ! -e "$T/store/storage-stop" ]] && grep -q "= 490000000000 bytes" "$T/sck.sum" || bad+=" [0.49: $rc $(head -c 200 "$T/sck.out")]"
(DATA_REPO=test/data DATA_STORE_TOKEN=x GH_REPO=test/repo GH_BIN="$T/storegh"; . "$here/archive-guard.sh"; ag_summary=/dev/null; ag_store_ok) >/dev/null 2>&1 || bad+=" [guard refused without the marker]"
# A draft storage-stop does not count: the guard passes, and a stop still writes the published marker.
mkdir -p "$T/store/storage-stop"; touch "$T/store/storage-stop/.draft"
(DATA_REPO=test/data DATA_STORE_TOKEN=x GH_REPO=test/repo GH_BIN="$T/storegh"; . "$here/archive-guard.sh"; ag_summary=/dev/null; ag_store_ok) >/dev/null 2>&1 || bad+=" [a draft counted]"
# After batch 1: the K2 day (45 GB) counts as its 5 GB PM-01 subset + its 1 GB events: 45 + 30 x 6 = 225 GB, not 45 + 30 x 45 = 1395 GB.
rm -rf "$T/store"; mkday data-day-2026-07-22 45000000000 5000000000
sck; [[ $rc == 0 && ! -e "$T/store/storage-stop" ]] && grep -q "= 225000000000 bytes" "$T/sck.sum" && grep -q "measured PM-01 subset" "$T/sck.sum" || bad+=" [batch 1: $rc $(head -c 200 "$T/sck.out")]"
# OF-4 ruling 6: everything stored for a day counts. After batch 1, the K2 day (45 GB with a 1 GB
# events tar) and its 1 GB volume release: 46 GB stored + 30 x (14 GB subset + 1 GB events + 1 GB
# volume) = 526 GB > 0.5 TB -> the marker (the subset alone would give 466 GB and pass).
rm -rf "$T/store"; mkday data-day-2026-07-22 45000000000 14000000000; mkday data-volume-2026-07-22 1000000000
sck; [[ $rc == 3 && -d "$T/store/storage-stop" ]] && grep -q "= 526000000000 bytes" "$T/sck.sum" || bad+=" [near cap: $rc $(head -c 300 "$T/sck.sum")]"
rm -rf "$T/store"; mkday data-day-2026-07-22 45000000000 5000000000
# Fail closed, no marker: an unreadable subset file, an empty store, an unreadable store.
echo "n/a" > "$T/store/data-day-2026-07-22/pm01-subset-2026-07-22.txt"; sck; [[ $rc == 1 && ! -e "$T/store/storage-stop" ]] || bad+=" [bad subset: $rc]"
rm -rf "$T/store"; mkdir -p "$T/store"; sck; [[ $rc == 1 ]] || bad+=" [empty: $rc]"
rc=0; GH_BIN="$T/ghrec4" bash "$here/storage-check.sh" >/dev/null 2>&1 || rc=$?; [[ $rc == 1 ]] || bad+=" [unreadable: $rc]"
[[ -z "$bad" ]] && ok "OF-4 storage stop: after batch 5, 120 GB stored + 26 x 15 GB = 0.51 TB writes the published storage-stop marker (once) and exits 3, and the guard then refuses; 0.49 TB passes; a draft marker does not count; after batch 1 the K2 day counts as its measured PM-01 subset plus its events and volume (225 GB, not 1.395 TB), and near the cap (526 GB with them, 466 GB without) it stops; a bad subset, an empty or unreadable store fail closed without a marker" || no "OF-4 storage stop:$bad"
bad=""

# ---- OF-4 ruling 1: the stored day's progress cache is deleted after the read-back, by the forget job alone ----
bad=""
cat > "$T/cfgh" <<'EOF'
#!/usr/bin/env bash
echo "$*" >> "$T/cf.log"
[[ "$1 $2" == "api -X" ]] && exit 0
[[ -n "${CF_FAIL:-}" ]] && { echo "HTTP 502" >&2; exit 1; }
printf '11\tdata-scan-2026-07-24-k0123456789ab-77-1\n12\tdata-scan-2026-07-24-k0123456789ab-77-1-qa\n13\tdata-scan-2026-07-24-k0123456789ab-78-2-logs\n14\tdata-scan-2026-07-25-k0123456789ab-79-1\n15\tdata-scan-2026-07-24-kfedcba987654-77-1\n'
EOF
chmod +x "$T/cfgh"
: > "$T/cf.log"; GH_BIN="$T/cfgh" GH_REPO=o/r bash "$here/cache-forget.sh" data-scan-2026-07-24-k0123456789ab- >/dev/null 2>&1 || bad+=" [run]"
[[ "$(grep -- '-X DELETE' "$T/cf.log" | sed 's#.*/caches/##' | tr '\n' ' ')" == "11 12 13 " ]] || bad+=" [deleted: $(grep -- '-X DELETE' "$T/cf.log" | tr '\n' ' ')]"
for pf in "" data-scan-2026-07-24- data-scan-2026-07-24-k0123456789ab data-rpc-2026-07-24-k0123456789ab- 'data-scan-2026-07-24-k0123456789ab-*' data-scan-; do
  : > "$T/cf.log"; rc=0; GH_BIN="$T/cfgh" GH_REPO=o/r bash "$here/cache-forget.sh" "$pf" >/dev/null 2>&1 || rc=$?
  [[ $rc == 2 && ! -s "$T/cf.log" ]] || bad+=" [prefix '$pf': $rc]"
done
: > "$T/cf.log"; rc=0; CF_FAIL=1 GH_BIN="$T/cfgh" GH_REPO=o/r bash "$here/cache-forget.sh" data-scan-2026-07-24-k0123456789ab- >/dev/null 2>&1 || rc=$?
[[ $rc == 1 ]] && ! grep -q -- '-X DELETE' "$T/cf.log" || bad+=" [list error: $rc]"
python3 - "$wf/data-scan.yml" <<'PY' || bad+=" [workflow]"
import sys, yaml
jobs = yaml.safe_load(open(sys.argv[1]))["jobs"]
for j, job in jobs.items():
    if (job.get("permissions") or {}).get("actions") == "write":
        assert j in ("continue", "forget"), j
f = jobs["forget"]
assert f["needs"] == "scan" and f["if"] == "always() && inputs.mode == 'scan' && needs.scan.outputs.forget != ''", f
assert f["permissions"] == {"contents": "read", "actions": "write"}, f["permissions"]
st = f["steps"]; assert len(st) == 2 and st[0]["uses"].startswith("actions/checkout@") and st[0]["with"]["persist-credentials"] is False, st
assert st[1]["run"] == 'research/historical/ci/cache-forget.sh "$PREFIX"' and st[1]["env"]["PREFIX"] == "${{ needs.scan.outputs.forget }}", st
scan = jobs["scan"]; assert scan["outputs"] == {"forget": "${{ steps.forgetmark.outputs.prefix }}"}, scan.get("outputs")
steps = scan["steps"]; ids = [x.get("id") or x.get("name") for x in steps]
m = steps[ids.index("forgetmark")]
assert "steps.store.outputs.readback == 'true'" in m["if"] and "always()" not in m["if"] and ids.index("store") < ids.index("forgetmark"), m
assert 'echo "prefix=data-scan-$DAY-k$KID-" >> "$GITHUB_OUTPUT"' in m["run"], m
PY
# the guard: the forget job alone may hold actions: write, and only with a checkout and cache-forget.sh
gdreset; touch "$GD/noguard-$NG"
for v in extra-step scan-write other-run; do
  mkfx "$T/fxf"; w="$T/fxf/.github/workflows/data-scan.yml"
  python3 - "$w" "$v" <<'PY'
import sys
p, v = sys.argv[1], sys.argv[2]; s = open(p).read()
if v == "extra-step":
    s = s.replace('        run: research/historical/ci/cache-forget.sh "$PREFIX"\n', '        run: research/historical/ci/cache-forget.sh "$PREFIX"\n      - run: research/historical/ci/scan-day.sh x\n', 1)
elif v == "scan-write":
    s = s.replace("      actions: read # \"Pick the fullest progress cache\"", "      actions: write # \"Pick the fullest progress cache\"", 1)
else:
    s = s.replace('        run: research/historical/ci/cache-forget.sh "$PREFIX"\n', '        run: research/historical/ci/cache-forget.sh "$PREFIX" && gh workflow run data-scan.yml\n', 1)
open(p, "w").write(s)
PY
  ACFX=$T/fxf/research/historical/ci ac env AC_STATUS=206
  [[ ! -e "$A/curl.calls" ]] && grep -qE "held \(1\): the archive chain is not armed: .*(job forget holds actions: write|job scan grants actions: write)" "$A/summary.md" || bad+=" [guard $v]"
done
mkfx "$T/fxf"; ACFX=$T/fxf/research/historical/ci ac env AC_STATUS=206; [[ $(wc -l < "$A/curl.calls" 2>/dev/null) == 1 ]] || bad+=" [control: $(tail -c 300 "$A/summary.md")]"
[[ -z "$bad" ]] && ok "OF-4 ruling 1: cache-forget deletes exactly the stored day's data-scan-DAY-k<kid>-* entries (progress, -qa, -logs; not another day or key id), refuses any other prefix before a call and deletes nothing when the list fails; the forget job alone (with continue) holds actions: write, needs the scan job's prefix, which is set only after the read-back passed; the guard refuses an extra step, another command in it, or actions: write in the scan job; the tree as it is arms" || no "OF-4 forget:$bad"
bad=""

# ---- OF-4 ruling 5: the store token only in clean env -i steps; the assemble build holds none ----
bad=""; gdreset; touch "$GD/noguard-$NG"
for v in step job top; do
  mkfx "$T/fxt"; w="$T/fxt/.github/workflows/data-scan.yml"
  python3 - "$w" "$v" <<'PY'
import sys
p, v = sys.argv[1], sys.argv[2]; s = open(p).read()
if v == "step":
    a = "          ALLOW_REVISIONS: ${{ inputs.allow_revisions }}\n"
    assert s.count(a) == 1; s = s.replace(a, a + "          GH_TOKEN: ${{ secrets.DATA_STORE_TOKEN }}\n")
elif v == "job":
    i = s.index("\n  assemble:"); j = s.index("\n    runs-on:", i)
    s = s[:j] + "\n    env:\n      TOK: ${{ secrets.DATA_STORE_TOKEN }}" + s[j:]
else:
    a = "\nenv:\n"; assert s.count(a) == 1; s = s.replace(a, a + "  TOK: ${{ secrets.DATA_STORE_TOKEN }}\n")
open(p, "w").write(s)
PY
  ACFX=$T/fxt/research/historical/ci ac env AC_STATUS=206
  [[ ! -e "$A/curl.calls" ]] && grep -q "holds the store token" "$A/summary.md" || bad+=" [guard $v: $(grep -o 'refused[^|]*' "$A/summary.md" | head -1 | cut -c1-120)]"
done
reset_store; rc=0; bash "$here/assemble.sh" --download 2026-09-20 2026-09-22 "$T/work" >/dev/null 2>&1 || rc=$?
out=$(GH_TOKEN=x bash "$here/assemble.sh" 2026-09-20 2026-09-22 "$T/work" 2>&1) && bad+=" [build with GH_TOKEN]"
[[ $rc == 0 && "$out" == *"runs without a token"* && ! -e "$T/work/data/units" ]] || bad+=" [build msg: $rc ${out:0:80}]"
out=$(env -u GH_TOKEN GITHUB_TOKEN=y bash "$here/assemble.sh" 2026-09-20 2026-09-22 "$T/work" 2>&1) && bad+=" [build with GITHUB_TOKEN]"
out=$(bash "$here/assemble.sh" --store 2026-09-20 2026-09-22 "$T/w5" 2>&1) && bad+=" [store without a build]"
[[ "$out" == *"no built release"* ]] || bad+=" [store msg: ${out:0:80}]"
[[ -z "$bad" ]] && ok "OF-4 ruling 5: arming refuses the store token in a step outside a clean env -i step, in a job env or in the top-level env; assemble's build refuses to run with GH_TOKEN or GITHUB_TOKEN set, and --store refuses without a built release" || no "OF-4 store token:$bad"
bad=""

# ---- OF-5: completion from the private store; read done and B-10 done; the prior list from the store ----
bad=""; export GH_BIN="$T/bin/gh"
# --check: a complete data-day-D or data-day-D-k3 in the store is read done; nothing else is.
cat > "$T/ckgh" <<'EOF'
#!/usr/bin/env bash
# serves the fake release store only for the repository in CK_REPO; any other is "release not found"
repo=-; prev=""; for x in "$@"; do [[ "$prev" == --repo ]] && repo=$x; prev=$x; done
[[ "$repo" == "$CK_REPO" ]] || { echo "release not found" >&2; exit 1; }
exec "$T/bin/gh" "$@"
EOF
chmod +x "$T/ckgh"
ck() { : > "$T/ckout"; rc=0; CK_REPO=${CK_REPO:-test/data} GH_BIN="$T/ckgh" GITHUB_OUTPUT="$T/ckout" bash "$here/publish-day.sh" --check "$1" >/dev/null 2>&1 || rc=$?; }
d5=2026-09-27; rm -rf "$T/rel/data-day-$d5" "$T/rel/data-day-$d5-k3"
ck $d5; [[ $rc == 0 ]] && grep -qx complete=false "$T/ckout" || bad+=" [none: $rc]"
mk5() { local tag=$1; rm -rf "$T/rel/$tag"; mkdir -p "$T/rel/$tag"; for f in units-$d5.tar.part00 events-$d5.tar qa-$d5.md qa-$d5.json manifest-$d5.json parity-$d5.json units-$d5.log; do echo "$f" > "$T/rel/$tag/$f"; done
  (cd "$T/rel/$tag" && sha256sum units-* events-* qa-* manifest-* parity-* > "SHA256SUMS-$d5")
  printf 'readback-ok %s %s' "$tag" "$(sha256sum "$T/rel/$tag/SHA256SUMS-$d5" | cut -d' ' -f1)" > "$T/rel/$tag/readback-ok-$d5"; }
mk5 "data-day-$d5"; ck $d5; [[ $rc == 0 ]] && grep -qx complete=true "$T/ckout" || bad+=" [plain: $rc]"
rm -rf "$T/rel/data-day-$d5"; mk5 "data-day-$d5-k3"; ck $d5; [[ $rc == 0 ]] && grep -qx complete=true "$T/ckout" || bad+=" [k3: $rc]"
CK_REPO=test/repo ck $d5; [[ $rc == 0 ]] && grep -qx complete=false "$T/ckout" || bad+=" [this repo counted: $rc]"
rm "$T/rel/data-day-$d5-k3/units-$d5.log"; ck $d5; [[ $rc == 1 ]] && ! grep -q complete= "$T/ckout" || bad+=" [incomplete k3: $rc]"
FAKE_GH_ERROR=1 ck $d5; [[ $rc == 1 ]] && ! grep -q complete= "$T/ckout" || bad+=" [store error: $rc]"
rm -rf "$T/rel/data-day-$d5" "$T/rel/data-day-$d5-k3"
[[ -z "$bad" ]] && ok "OF-5 read done (skip step): a complete data-day-D or data-day-D-k3 in the private store skips the day; none, or a release only in this repository, does not; an incomplete release or a store error fails the step with no output" || no "OF-5 read done:$bad"
bad=""
# OF-5 ruling 1: done only with the readback-ok marker, written after the read-back and read back.
d6=2026-09-30
mkpd; rm -rf "$T/rel/data-day-$d6"; : > "$T/ghout4"
GH_BIN="$T/bin/gh" GITHUB_OUTPUT="$T/ghout4" bash "$here/publish-day.sh" $d6 "$pd" >/dev/null 2>&1 || bad+=" [store]"
grep -qx readback=true "$T/ghout4" && [[ "$(cat "$T/rel/data-day-$d6/readback-ok-$d6")" == "readback-ok data-day-$d6 $(sha256sum "$T/rel/data-day-$d6/SHA256SUMS-$d6" | cut -d' ' -f1)" ]] || bad+=" [no marker after the read-back]"
ck $d6; [[ $rc == 0 ]] && grep -qx complete=true "$T/ckout" || bad+=" [marked: $rc]"
GH_BIN="$T/bin/gh" GITHUB_OUTPUT=/dev/null bash "$here/publish-day.sh" $d6 "$pd" >/dev/null 2>&1 || bad+=" [done rerun]"
# complete names, one wrong byte: the read-back fails, no marker is written, the day is not done
for c in units-$d6.tar.part01 units-$d6.log; do
  rm -rf "$T/rel/data-day-$d6"; mkpd; : > "$T/ghout4"
  FAKE_GH_CORRUPT=$c GH_BIN="$T/bin/gh" GITHUB_OUTPUT="$T/ghout4" bash "$here/publish-day.sh" $d6 "$pd" >/dev/null 2>&1 && bad+=" [$c stored]"
  [[ ! -s "$T/ghout4" && ! -e "$T/rel/data-day-$d6/readback-ok-$d6" ]] || bad+=" [$c marked]"
  ck $d6; [[ $rc == 1 ]] && ! grep -q complete= "$T/ckout" || bad+=" [$c counted: $rc $(cat "$T/ckout")]"
  out=$(GH_BIN="$T/bin/gh" bash "$here/publish-day.sh" $d6 "$pd" 2>&1) && bad+=" [$c re-stored]"
  [[ "$out" == *"stopped for review"* ]] || bad+=" [$c rerun: ${out:0:80}]"
done
# a marker that does not match the stored SHA256SUMS, or a lost marker read-back
rm -rf "$T/rel/data-day-$d6"; mkpd; GH_BIN="$T/bin/gh" bash "$here/publish-day.sh" $d6 "$pd" >/dev/null 2>&1
echo x >> "$T/rel/data-day-$d6/readback-ok-$d6"; ck $d6; [[ $rc == 1 ]] && ! grep -q complete= "$T/ckout" || bad+=" [bad marker: $rc]"
rm -rf "$T/rel/data-day-$d6"; mkpd; : > "$T/ghout4"
FAKE_GH_CORRUPT=readback-ok-$d6 GH_BIN="$T/bin/gh" GITHUB_OUTPUT="$T/ghout4" bash "$here/publish-day.sh" $d6 "$pd" >/dev/null 2>&1 && bad+=" [marker read-back passed]"
[[ ! -s "$T/ghout4" ]] || bad+=" [marker read-back output]"
rm -rf "$T/rel/data-day-$d6"
# the guard: an unmarked day release is not read done and stops the queue
gdreset; printf '2026-07-22\n2026-07-23\n' > "$GD/published"
(export GD GH_BIN="$GD/bin/gh" GH_REPO=o/r DATA_REPO=o/data DATA_STORE_TOKEN=tok; . "$here/archive-guard.sh"; ag_read_done) > "$T/rd" 2>/dev/null; [[ "$(tr '\n' ' ' < "$T/rd")" == "2026-07-22 2026-07-23 " ]] || bad+=" [marked read done: $(cat "$T/rd")]"
echo 2026-07-23 > "$GD/unmarked"; rm -rf "$GD/rel"; rc=0
(export GD GH_BIN="$GD/bin/gh" GH_REPO=o/r DATA_REPO=o/data DATA_STORE_TOKEN=tok; . "$here/archive-guard.sh"; ag_read_done) > "$T/rd" 2> "$T/rde" || rc=$?
[[ $rc != 0 && ! -s "$T/rd" ]] && grep -q "no readback-ok marker" "$T/rde" || bad+=" [unmarked: $rc $(cat "$T/rd")]"
b10() { rc=0; GD="$GD" GH_BIN="$GD/bin/gh" GH_REPO=o/r DATA_REPO=o/data DATA_STORE_TOKEN=tok bash "$here/archive-guard.sh" b10-done > "$T/b10" 2>/dev/null || rc=$?; }
printf '2026-07-22-k3\n2026-07-24\n' > "$GD/published"; echo 2026-07-24 > "$GD/unmarked"; rm -rf "$GD/rel"; b10
[[ $rc == 0 && "$(tr '\n' ' ' < "$T/b10")" == "2026-07-22 " ]] || bad+=" [b10 unmarked: $rc $(tr '\n' ' ' < "$T/b10")]"
# OF-5 ruling 3: a tagged release with one asset not uploaded is not done (guard and --check)
gdreset; printf '2026-07-22\n2026-07-23\n' > "$GD/published"; GD="$GD" "$GD/bin/mkrel" 2026-07-23; echo events-2026-07-23.tar > "$GD/rel/data-day-2026-07-23/.partial"; rc=0
(export GD GH_BIN="$GD/bin/gh" GH_REPO=o/r DATA_REPO=o/data DATA_STORE_TOKEN=tok; . "$here/archive-guard.sh"; ag_read_done) > "$T/rd" 2> "$T/rde" || rc=$?
[[ $rc != 0 && ! -s "$T/rd" ]] && grep -q "data-day-2026-07-23 .*not complete" "$T/rde" || bad+=" [guard partial: $rc $(cat "$T/rd")]"
printf '2026-07-24\n' > "$GD/published"; GD="$GD" "$GD/bin/mkrel" 2026-07-24; echo qa-2026-07-24.md > "$GD/rel/data-day-2026-07-24/.partial"; b10
[[ $rc == 0 && ! -s "$T/b10" ]] || bad+=" [b10 partial: $rc $(cat "$T/b10")]"
mk5 "data-day-$d5"; echo "events-$d5.tar" > "$T/rel/data-day-$d5/.partial"; ck $d5; [[ $rc == 1 ]] && ! grep -q complete= "$T/ckout" || bad+=" [check partial: $rc]"
rm -rf "$T/rel/data-day-$d5"
gdreset
[[ -z "$bad" ]] && ok "OF-5 ruling 1: a day release is done only with its readback-ok marker, stored after every asset was read back and itself read back; complete names with one wrong byte, a marker that does not match or a marker read-back that fails is not done (--check fails, a rerun stops for review); the guard's read done and B-10 done count only marked releases, and an unmarked one stops the queue; ruling 3: the guard judges a release as --check does (release-state.sh), so one asset not uploaded is not done for the guard, B-10 done or --check" || no "OF-5 ruling 1:$bad"
bad=""
# B-10 done: the -k3 release for the two measurement days, the plain one for the others.
b10() { rc=0; GD="$GD" GH_BIN="$GD/bin/gh" GH_REPO=o/r DATA_REPO=o/data DATA_STORE_TOKEN=tok bash "$here/archive-guard.sh" b10-done > "$T/b10" 2>/dev/null || rc=$?; }
gdreset
echo 2026-07-22 > "$GD/published"; b10; [[ $rc == 0 && ! -s "$T/b10" ]] || bad+=" [K2 counted: $(cat "$T/b10" | tr '\n' ' ')]"
printf '2026-07-22\n2026-07-22-k3\n2026-07-23\n2026-07-24\n2026-07-26\n' > "$GD/published"; b10
[[ $rc == 0 && "$(tr '\n' ' ' < "$T/b10")" == "2026-07-22 2026-07-24 2026-07-26 " ]] || bad+=" [mix: $rc $(tr '\n' ' ' < "$T/b10")]"
GD_STORE_FAIL=1 b10; [[ $rc == 2 ]] || bad+=" [store error: $rc]"
# ... while the queue still counts the K2 release as read done (07-22 is never read twice)
echo 2026-07-22 > "$GD/published"
(export GD GH_BIN="$GD/bin/gh" GH_REPO=o/r DATA_REPO=o/data DATA_STORE_TOKEN=tok; . "$here/archive-guard.sh"; ag_read_done) > "$T/rd" 2>/dev/null; [[ "$(cat "$T/rd")" == 2026-07-22 ]] || bad+=" [read done: $(cat "$T/rd")]"
gdreset
[[ -z "$bad" ]] && ok "OF-5 B-10 done: the K2 release data-day-2026-07-22 is read done but never B-10 done, data-day-2026-07-22-k3 is; 07-23 at K2 is not; other days at K3 count plain; a store error fails closed" || no "OF-5 B-10 done:$bad"
bad=""
# OF-6 ruling 5: the -k3 release goes through publish-day.sh --k3 (same read-back and marker),
# and every release create of a data-day-* tag sits in a script that writes and reads back the marker.
d7=2026-09-30; mkpd; rm -rf "$T/rel/data-day-$d7" "$T/rel/data-day-$d7-k3"; : > "$T/ghout4"
GH_BIN="$T/bin/gh" GITHUB_OUTPUT="$T/ghout4" bash "$here/publish-day.sh" $d7 "$pd" --k3 >/dev/null 2>&1 || bad+=" [k3 store]"
[[ ! -d "$T/rel/data-day-$d7" ]] && grep -qx readback=true "$T/ghout4" &&
  [[ "$(cat "$T/rel/data-day-$d7-k3/readback-ok-$d7" 2>/dev/null)" == "readback-ok data-day-$d7-k3 $(sha256sum "$T/rel/data-day-$d7-k3/SHA256SUMS-$d7" | cut -d' ' -f1)" ]] || bad+=" [k3 marker]"
ck $d7; [[ $rc == 0 ]] && grep -qx complete=true "$T/ckout" || bad+=" [k3 not done: $rc]"
rm -rf "$T/rel/data-day-$d7-k3"; mkpd
GH_BIN="$T/bin/gh" bash "$here/publish-day.sh" $d7 "$pd" --k2 >/dev/null 2>&1 && bad+=" [bad flag taken]"
[[ ! -d "$T/rel/data-day-$d7" && ! -d "$T/rel/data-day-$d7-k3" ]] || bad+=" [bad flag stored]"
rm -rf "$T/rel/data-day-$d7" "$T/rel/data-day-$d7-k3"
cat > "$T/creates.py" <<'PY'
import os, re, sys
# every `release create` whose tag is (or a variable assigned) data-day-*, in any script or
# workflow, must sit in a file that uploads readback-ok and downloads it back
root = sys.argv[1]; bad = []
for d, _, fs in os.walk(root):
    if "/node_modules" in d or "/.git" in d: continue
    for f in fs:
        if not f.endswith((".sh", ".yml", ".yaml")) or f == "test-ci.sh": continue
        p = os.path.join(d, f); t = open(p, errors="replace").read()
        for m in re.finditer(r"release\s+create\s+(\S+)", t):
            a = m.group(1).strip("'\"")
            v = re.fullmatch(r"\$\{?(\w+)\}?", a)
            vals = re.findall(r"\b" + v.group(1) + r"=[\"']?([^\s\"';]+)", t) if v else [a]
            if any("data-day-" in x for x in vals) and not (re.search(r"release upload[^\n]*readback-ok", t) and re.search(r"release download[^\n]*readback-ok", t)):
                bad.append(os.path.relpath(p, root))
print(" ".join(sorted(set(bad))))
PY
r=$(python3 "$T/creates.py" "$here/../../..") ; [[ -z "$r" ]] || bad+=" [creates without the marker: $r]"
mkdir -p "$T/cr/x"; printf 'tag="data-day-$d-k3"\ngh release create "$tag" --repo "$DATA_REPO" -- a\n' > "$T/cr/x/k3.sh"
[[ "$(python3 "$T/creates.py" "$T/cr")" == "x/k3.sh" ]] || bad+=" [planted producer not caught]"
printf 'gh release create data-day-2026-07-22-k3 --repo "$DATA_REPO" -- a\n' > "$T/cr/x/k3.sh"
[[ "$(python3 "$T/creates.py" "$T/cr")" == "x/k3.sh" ]] || bad+=" [planted literal not caught]"
[[ -z "$bad" ]] && ok "OF-6 ruling 5: publish-day.sh --k3 stores the trimmed day as data-day-D-k3 with the same read-back and readback-ok marker (done at once for --check); an unknown flag stores nothing; every data-day-* release create in a script or workflow sits in a file that writes and reads back the marker (a planted producer without it is caught)" || no "OF-6 ruling 5:$bad"
bad=""
# OF-5 ruling 2: B-10 done from the recorded retention (units-D.log all K3 with the list sha256), not the tag name.
mkb() { GD="$GD" "$GD/bin/mkrel" "$@"; }
gdreset; echo 2026-07-22 > "$GD/published"; mkb 2026-07-22 K3 K3; b10
[[ $rc == 0 && "$(cat "$T/b10")" == 2026-07-22 ]] || bad+=" [07-22 K3 plain: $rc $(cat "$T/b10")]"
mkb 2026-07-22 K3 K2; b10; [[ $rc == 0 && ! -s "$T/b10" ]] || bad+=" [mixed K3/K2 counted]"
mkb 2026-07-22 K3 K3 "$(printf '0%.0s' {1..64})"; b10; [[ $rc == 0 && ! -s "$T/b10" ]] || bad+=" [another list's sha counted]"
echo 2026-07-22-k3 > "$GD/published"; mkb 2026-07-22-k3 K2 K2; b10; [[ $rc == 0 && ! -s "$T/b10" ]] || bad+=" [K2 under the -k3 tag counted]"
echo 2026-07-25 > "$GD/published"; mkb 2026-07-25 K2 K2; b10; [[ $rc == 0 && ! -s "$T/b10" ]] || bad+=" [K2 plain day counted]"
mkb 2026-07-25 K3 K3; b10; [[ $rc == 0 && "$(cat "$T/b10")" == 2026-07-25 ]] || bad+=" [07-25 K3: $(cat "$T/b10")]"
rm "$GD/rel/data-day-2026-07-25/units-2026-07-25.log"; b10; [[ $rc == 0 && ! -s "$T/b10" ]] || bad+=" [no units log counted]"
gdreset
[[ -z "$bad" ]] && ok "OF-5 ruling 2: B-10 done is judged from the recorded retention: 2026-07-22 stored at K3 under the plain tag counts; a unit line at K2, another list's sha256, K2 under a -k3 tag, a K2 plain day or a release without its per-unit log does not" || no "OF-5 ruling 2:$bad"
bad=""
# The prior list: none for the first allow-listed day; for D, list-<D-1>.txt and its SHA256SUMS from the store.
pf() { : > "$T/pfout"; rc=0; GITHUB_OUTPUT="$T/pfout" bash "$here/prior-fetch.sh" "$1" "$T/pfdir" > "$T/pf.txt" 2>&1 || rc=$?; }
rm -rf "$T/rel/data-day-2026-07-22" "$T/rel/data-day-2026-07-22-k3" "$T/pfdir"
pf 2026-07-22; [[ $rc == 0 && "$(cat "$T/pfout")" == $'list=\nsums=' ]] || bad+=" [first: $rc $(cat "$T/pfout")]"
pf 2026-07-23; [[ $rc == 1 && ! -s "$T/pfout" ]] || bad+=" [missing: $rc]"
mkdir -p "$T/rel/data-day-2026-07-22"; echo "pool 1 2" > "$T/rel/data-day-2026-07-22/list-2026-07-22.txt"
(cd "$T/rel/data-day-2026-07-22" && sha256sum list-2026-07-22.txt > SHA256SUMS-2026-07-22)
pf 2026-07-23; [[ $rc == 0 ]] && grep -qx "list=$T/pfdir/list-2026-07-22.txt" "$T/pfout" && grep -qx "sums=$T/pfdir/SHA256SUMS-2026-07-22" "$T/pfout" || bad+=" [plain: $rc $(cat "$T/pf.txt")]"
bash "$here/archive-guard.sh" prior 2026-07-23 "$T/pfdir/list-2026-07-22.txt" "$T/pfdir/SHA256SUMS-2026-07-22" >/dev/null 2>&1 || bad+=" [guard refused the fetched pair]"
mv "$T/rel/data-day-2026-07-22" "$T/rel/data-day-2026-07-22-k3"
pf 2026-07-23; [[ $rc == 0 ]] && grep -qx "list=$T/pfdir/list-2026-07-22.txt" "$T/pfout" || bad+=" [k3: $rc]"
rm "$T/rel/data-day-2026-07-22-k3/SHA256SUMS-2026-07-22"; pf 2026-07-23; [[ $rc == 1 && ! -s "$T/pfout" ]] || bad+=" [no sums: $rc]"
rm -rf "$T/rel/data-day-2026-07-22-k3"
rc=0; DATA_REPO= GITHUB_OUTPUT="$T/pfout" bash "$here/prior-fetch.sh" 2026-07-23 "$T/pfdir" >/dev/null 2>&1 || rc=$?; [[ $rc == 1 ]] || bad+=" [no store: $rc]"
unset GH_BIN
python3 - "$wf/data-scan.yml" <<'PY' || bad+=" [workflow]"
import sys, yaml
job = yaml.safe_load(open(sys.argv[1]))["jobs"]["scan"]
assert "ARCHIVE_PRIOR_LIST" not in str(job.get("env") or {}), job.get("env")
steps = job["steps"]; ids = [x.get("id") or x.get("name") for x in steps]
pr = steps[ids.index("prior")]
assert pr["env"]["GH_TOKEN"] == "${{ secrets.DATA_STORE_TOKEN }}" and pr["run"].startswith("/usr/bin/env -i PATH=/usr/bin:/bin ") and 'prior-fetch.sh" "$DAY"' in pr["run"], pr
assert "steps.published.outputs.complete != 'true'" in pr["if"] and "inputs.source != 'helius'" in pr["if"], pr
assert ids.index("prior") < ids.index("scan") < ids.index("trim"), ids
for k in ("scan", "trim"):
    e = steps[ids.index(k)]["env"]
    assert e["ARCHIVE_PRIOR_LIST"] == "${{ steps.prior.outputs.list }}" and e["ARCHIVE_PRIOR_SUMS"] == "${{ steps.prior.outputs.sums }}", (k, e)
PY
[[ -z "$bad" ]] && ok "OF-5 prior list: the first allow-listed day gets none; day D gets list-<D-1>.txt and SHA256SUMS-<D-1> from data-day-<D-1> (else its -k3) in the store, which archive-guard.sh prior accepts; a missing release or file, or no store, fails closed with no output; the scan job fetches it in a clean step and hands the same outputs to the scan and the trim" || no "OF-5 prior list:$bad"
# ---- OF-4 round 2 (rulings 7-10) ----
bad=""
# 7. One archive day per run: the plan refuses two before any request, and the forget marker
# refuses a matrix of more than one job.
python3 - "$wf/data-scan.yml" > "$T/plan7.py" <<'PY'
import sys, yaml
st = next(x for x in yaml.safe_load(open(sys.argv[1]))["jobs"]["plan"]["steps"] if x.get("id") == "days")
r = st["run"]; i = r.index("\n", r.index("<<'EOF'")) + 1; print(r[i:r.rindex("EOF")])
PY
rc=0; MODE=scan DAYS=2026-07-22,2026-07-23 MAX_MBPS=40 SOURCE=archive MAX_CREDITS=0 RPC_RPS=5 REGIME_BOUNDARY_DAY=2026-10-02 python3 "$T/plan7.py" > "$T/plan7.out" 2>&1 || rc=$?
[[ $rc != 0 ]] && grep -q "one UTC day per batch" "$T/plan7.out" && ! grep -q '^days=' "$T/plan7.out" || bad+=" [plan two days: $rc]"
rc=0; MODE=scan DAYS=2026-07-22 MAX_MBPS=40 SOURCE=archive MAX_CREDITS=0 RPC_RPS=5 REGIME_BOUNDARY_DAY=2026-10-02 python3 "$T/plan7.py" > "$T/plan7.out" 2>&1 || rc=$?
[[ $rc == 0 ]] && grep -qx 'archive_day=2026-07-22' "$T/plan7.out" || bad+=" [plan one day: $rc]"
python3 - "$wf/data-scan.yml" <<'PY' || bad+=" [forget marker]"
import sys, yaml
st = next(x for x in yaml.safe_load(open(sys.argv[1]))["jobs"]["scan"]["steps"] if x.get("id") == "forgetmark")
assert st["env"]["JOBS"] == "${{ strategy.job-total }}" and st["run"].lstrip().startswith('[[ "$JOBS" == 1 ]] ||'), st
PY
[[ -z "$bad" ]] && ok "OF-4 ruling 7: the plan refuses a two-day archive scan (no day list, so no request) and passes one day; the forget marker refuses a matrix of more than one job" || no "OF-4 one day:$bad"
bad=""; gdreset; touch "$GD/noguard-$NG"
# 8. The guard refuses secrets.DATA_STORE_TOKEN in a run: line, toJSON(secrets), secrets[...] and secrets: inherit.
for v in run tojson index inherit; do
  mkfx "$T/fx8"; w="$T/fx8/.github/workflows/data-scan.yml"
  python3 - "$w" "$v" <<'PY'
import sys
p, v = sys.argv[1], sys.argv[2]; s = open(p).read()
a = "        run: research/historical/ci/assemble.sh \"$FROM\" \"$TO\" /mnt/work\n"
assert s.count(a) == 1
add = {"run": "        run: echo ${{ secrets.DATA_STORE_TOKEN }} >/dev/null; research/historical/ci/assemble.sh \"$FROM\" \"$TO\" /mnt/work\n",
       "tojson": a + "      - name: all\n        env:\n          ALL: ${{ toJSON(secrets) }}\n        run: true\n",
       "index": a + "      - name: one\n        env:\n          ONE: ${{ secrets['DATA_STORE_TOKEN'] }}\n        run: true\n",
       "inherit": a.replace("        run:", "        run:") + "    secrets: inherit\n"}[v]
open(p, "w").write(s.replace(a, add))
PY
  ACFX=$T/fx8/research/historical/ci ac env AC_STATUS=206
  case $v in run) m="writes secrets.DATA_STORE_TOKEN into its run: line" ;; tojson) m="uses toJSON(secrets)" ;; index) m="uses secrets\[...\]" ;; inherit) m="uses secrets: inherit" ;; esac
  [[ ! -e "$A/curl.calls" ]] && grep -q "$m" "$A/summary.md" || bad+=" [$v: $(grep -o 'refused[^|]*' "$A/summary.md" | head -1 | cut -c1-120)]"
done
[[ -z "$bad" ]] && ok "OF-4 ruling 8: arming refuses secrets.DATA_STORE_TOKEN written into a run: line, toJSON(secrets), secrets[...] and secrets: inherit in an archive workflow" || no "OF-4 secrets text:$bad"
# ---- OF-4 ruling 13: the store-token secret name matches without regard to case ----
bad=""; gdreset; touch "$GD/noguard-$NG"
for v in step job top mixed; do
  mkfx "$T/fx13"; w="$T/fx13/.github/workflows/data-scan.yml"
  python3 - "$w" "$v" <<'PY'
import sys
p, v = sys.argv[1], sys.argv[2]; s = open(p).read()
if v in ("step", "mixed"):
    a = "          ALLOW_REVISIONS: ${{ inputs.allow_revisions }}\n"
    assert s.count(a) == 1; s = s.replace(a, a + "          GH_TOKEN: ${{ secrets.data_store_token }}\n")
    if v == "mixed": s = s.replace("GH_TOKEN: ${{ secrets.data_store_token }}", "GH_TOKEN: ${{ secrets.Data_Store_Token }}")
elif v == "job":
    i = s.index("\n  assemble:"); j = s.index("\n    runs-on:", i)
    s = s[:j] + "\n    env:\n      TOK: ${{ secrets.data_store_token }}" + s[j:]
else:
    a = "\nenv:\n"; assert s.count(a) == 1; s = s.replace(a, a + "  TOK: ${{ secrets.Data_Store_Token }}\n")
open(p, "w").write(s)
PY
  ACFX=$T/fx13/research/historical/ci ac env AC_STATUS=206
  [[ ! -e "$A/curl.calls" ]] && grep -q "holds the store token" "$A/summary.md" || bad+=" [$v: $(grep -o 'refused[^|]*' "$A/summary.md" | head -1 | cut -c1-120)]"
done
[[ -z "$bad" ]] && ok "OF-4 ruling 13: arming refuses secrets.data_store_token (any case) in a step that is not clean, in a job env and in the top-level env" || no "OF-4 token case:$bad"
bad=""
bad=""; gdreset
# 9. After create, an incomplete release (an asset lost) fails before readback=true.
export GH_BIN="$T/bin/gh"
rm -rf "$T/rel/data-day-2026-09-30"; mkpd; : > "$T/ghout9"
out=$(FAKE_GH_DROP=parity-2026-09-30.json GITHUB_OUTPUT="$T/ghout9" bash "$here/publish-day.sh" 2026-09-30 "$pd" 2>&1) && bad+=" [passed]"
[[ "$out" == *"after create"* && ! -s "$T/ghout9" ]] || bad+=" [msg: ${out:0:120}]"
rm -rf "$T/rel/data-day-2026-09-30"; unset GH_BIN
[[ -z "$bad" ]] && ok "OF-4 ruling 9: a release missing an asset right after create fails the store step before any read-back, with no readback=true" || no "OF-4 complete after create:$bad"
bad=""
# 10. assemble --store: one create call with exactly the SHA256SUMS set, then a read-back.
reset_store; : > "$T/ghrepo.log"; run 2026-09-20 2026-09-22 "$T/work" || bad+=" [run: $(tail -2 "$T/out.txt")]"
R="$T/rel/data-2026-09-20-2026-09-22"
[[ $(grep -c "^create data-2026-09-20-2026-09-22 " "$T/ghrepo.log") == 1 ]] && ! grep -q "^upload data-2026-09-20-2026-09-22 " "$T/ghrepo.log" || bad+=" [calls]"
[[ "$(cd "$R" && ls | LC_ALL=C sort | tr '\n' ' ')" == "$( (awk '{print $2}' "$R/SHA256SUMS"; echo SHA256SUMS) | LC_ALL=C sort | tr '\n' ' ')" ]] || bad+=" [set]"
grep -q "files read back" "$T/out.txt" || bad+=" [no read-back line]"
reset_store; { bash "$here/assemble.sh" --download 2026-09-20 2026-09-22 "$T/work" && env -u GH_TOKEN -u GITHUB_TOKEN bash "$here/assemble.sh" 2026-09-20 2026-09-22 "$T/work"; } >/dev/null 2>&1
echo extra > "$T/work/release/stray.txt"
out=$(bash "$here/assemble.sh" --store 2026-09-20 2026-09-22 "$T/work" 2>&1) || bad+=" [stray: ${out:0:100}]"
[[ ! -e "$T/rel/data-2026-09-20-2026-09-22/stray.txt" ]] || bad+=" [stray uploaded]"
rm -rf "$T/rel/data-2026-09-20-2026-09-22"
out=$(FAKE_GH_CORRUPT=manifest.json bash "$here/assemble.sh" --store 2026-09-20 2026-09-22 "$T/work" 2>&1) && bad+=" [corrupt passed]"
[[ "$out" == *"read-back"* ]] || bad+=" [corrupt msg: ${out:0:100}]"
rm -rf "$T/rel/data-2026-09-20-2026-09-22"
out=$(FAKE_GH_DROP=manifest.json bash "$here/assemble.sh" --store 2026-09-20 2026-09-22 "$T/work" 2>&1) && bad+=" [dropped passed]"
[[ "$out" == *"differ from its SHA256SUMS set"* ]] || bad+=" [dropped msg: ${out:0:100}]"
[[ -z "$bad" ]] && ok "OF-4 ruling 10: assemble --store creates the dataset release in one call with exactly the files SHA256SUMS lists (a stray file stays behind), and fails when a stored file differs or one is missing" || no "OF-4 assemble store:$bad"
bad=""

# ---- OF-6: no second read of a margin unit, no whole-day re-read (docs/reviews/OF6.md) ----
bad=""
# 1. package-day: margin-DAY.tar holds the units reaching the next day (last block time at or
# after the next midnight minus 2 h), and SHA256SUMS lists it.
pm="$T/pm6"; rm -rf "$pm"; mkdir -p "$pm/out" "$pm/assets"; nm=$(date -u -d 2026-09-30 +%s)
for v in "1-2 $(( nm - 10000 ))" "3-4 $(( nm - 3000 ))" "5-6 $(( nm + 500 ))"; do set -- $v
  mkdir -p "$pm/out/units/1046/$1"; printf '{\n  "last_block_time": %s,\n  "retention": "K3"\n}\n' "$2" > "$pm/out/units/1046/$1/stats.json"; echo "e$1" > "$pm/out/units/1046/$1/events.jsonl.zst"; done
for f in qa-2026-09-29.md qa-2026-09-29.json parity-2026-09-29.json manifest-2026-09-29.json; do echo x > "$pm/assets/$f"; done
FAKE_AVAIL=999000000000 GITHUB_STEP_SUMMARY="$T/summary.md" bash "$here/package-day.sh" 2026-09-29 "$pm/out" "$pm/assets" > "$T/out.txt" 2>&1 || bad+=" [package: $(tail -2 "$T/out.txt")]"
[[ "$(tar -tf "$pm/assets/margin-2026-09-29.tar" 2>/dev/null | grep -E '^units/[0-9]+/[0-9-]+/?$' | sed 's#/$##' | LC_ALL=C sort | tr '\n' ' ')" == "units/1046/3-4 units/1046/5-6 " ]] || bad+=" [margin set: $(tar -tf "$pm/assets/margin-2026-09-29.tar" 2>&1 | tr '\n' ' ')]"
grep -q "  margin-2026-09-29.tar$" "$pm/assets/SHA256SUMS-2026-09-29" 2>/dev/null || bad+=" [not in sums]"
# 2. margin-fetch: day D takes D-1's margin units from a done release at D's retention,
# never from the archive (rulings 1, 6, 8; prev-units.txt for ruling 9).
export GH_BIN="$T/bin/gh"
mkfx "$T/fxm2" ARCHIVE_RETENTION=K2; mkfx "$T/fxm3" ARCHIVE_RETENTION=K3
mf() { rc=0; GITHUB_STEP_SUMMARY="$T/mf.sum" bash "${MFX:-$T/fxm2/research/historical/ci}/margin-fetch.sh" "$1" "$T/mfout" > "$T/mf.txt" 2>&1 || rc=$?; }
# mkmargin TAG RET [LINK]: a done release TAG of day ${TAG:9:10} whose units 1-2 (own), 3-4 and
# 5-6 (the margin) record RET; LINK adds a symlink member to the margin tar.
mkmargin() { local tag=$1 r=$2 d=${1:9:10} dir="$T/rel/$1" src="$T/mfsrc-$1" u
  rm -rf "$dir" "$src"; mkdir -p "$dir"
  for u in 1-2 3-4 5-6; do mkdir -p "$src/units/1046/$u"; printf '{"retention": "%s"}\n' "$r" > "$src/units/1046/$u/stats.json"; echo "$r d$u" > "$src/units/1046/$u/events.jsonl.zst"; done
  [[ -z "${3:-}" ]] || ln -s /etc/passwd "$src/units/1046/5-6/link.zst"
  tar -C "$src" -cf "$dir/units-$d.tar.part00" units
  tar -C "$src" -cf "$dir/margin-$d.tar" units/1046/3-4 units/1046/5-6
  echo "list $tag" > "$dir/list-$d.txt"; local ls; ls=$(sha256sum "$dir/list-$d.txt" | cut -d' ' -f1)
  printf '1046/1-2 r1 %s %s\n1046/3-4 r1 %s %s\n1046/5-6 r1 %s %s\n' "$r" "$ls" "$r" "$ls" "$r" "$ls" > "$dir/units-$d.log"
  for f in events-$d.tar qa-$d.md qa-$d.json manifest-$d.json parity-$d.json; do echo "$f" > "$dir/$f"; done
  (cd "$dir" && sha256sum units-* events-* qa-* manifest-* parity-* list-* margin-* > "SHA256SUMS-$d")
  printf 'readback-ok %s %s' "$tag" "$(sha256sum "$dir/SHA256SUMS-$d" | cut -d' ' -f1)" > "$dir/readback-ok-$d"; }
rm -rf "$T/mfout"; mf 2026-07-22; [[ $rc == 0 && ! -e "$T/mfout/from-store.txt" ]] || bad+=" [first day: $rc]"
mkmargin data-day-2026-07-22 K2; rm -rf "$T/mfout"; mf 2026-07-23
[[ $rc == 0 && -f "$T/mfout/units/1046/3-4/stats.json" && -f "$T/mfout/units/1046/5-6/events.jsonl.zst" && ! -e "$T/mfout/units/1046/1-2" ]] && [[ "$(cat "$T/mfout/from-store.txt")" == $'1046/3-4 data-day-2026-07-22\n1046/5-6 data-day-2026-07-22' ]] || bad+=" [take: $rc $(cat "$T/mf.txt")]"
[[ "$(cat "$T/mfout/prev-units.txt" 2>/dev/null | tr '\n' ' ')" == "1046/1-2 1046/3-4 1046/5-6 " ]] || bad+=" [prev-units: $(cat "$T/mfout/prev-units.txt" 2>&1)]"
echo own > "$T/mfout/units/1046/5-6/events.jsonl.zst"; mf 2026-07-23; [[ $rc == 0 && "$(cat "$T/mfout/units/1046/5-6/events.jsonl.zst")" == own && $(wc -l < "$T/mfout/from-store.txt") == 2 ]] || bad+=" [resume: $rc]"
mkmargin data-day-2026-07-22 K2; echo changed >> "$T/rel/data-day-2026-07-22/margin-2026-07-22.tar"; rm -rf "$T/mfout"; mf 2026-07-23; [[ $rc == 1 && ! -e "$T/mfout/units" ]] || bad+=" [sha: $rc]"
mkmargin data-day-2026-07-22 K2; mkdir -p "$T/mfsrc-x/evil"; echo x > "$T/mfsrc-x/evil/x"; tar -C "$T/mfsrc-data-day-2026-07-22" -cf "$T/rel/data-day-2026-07-22/margin-2026-07-22.tar" units -C "$T/mfsrc-x" evil
(d=$T/rel/data-day-2026-07-22; cd "$d" && sha256sum units-* events-* qa-* manifest-* parity-* list-* margin-* > SHA256SUMS-2026-07-22 && printf 'readback-ok data-day-2026-07-22 %s' "$(sha256sum SHA256SUMS-2026-07-22 | cut -d' ' -f1)" > readback-ok-2026-07-22)
rm -rf "$T/mfout"; mf 2026-07-23; [[ $rc == 1 && ! -e "$T/mfout/units" ]] || bad+=" [path: $rc]"
rm -rf "$T/rel/data-day-2026-07-22"; rm -rf "$T/mfout"; mf 2026-07-23; [[ $rc == 1 && ! -e "$T/mfout/units" ]] || bad+=" [missing: $rc]"
mkmargin data-day-2026-07-22 K2; rm "$T/rel/data-day-2026-07-22/readback-ok-2026-07-22"; rm -rf "$T/mfout"; mf 2026-07-23; [[ $rc == 1 && ! -e "$T/mfout/units" ]] && grep -q "not done" "$T/mf.txt" || bad+=" [unmarked: $rc]"
rm -rf "$T/rel/data-day-2026-07-22"
# ruling 8: a symlink member is refused before anything is extracted or taken
mkmargin data-day-2026-07-22 K2 link; rm -rf "$T/mfout"; mf 2026-07-23
[[ $rc == 1 && ! -e "$T/mfout/units" ]] && grep -q "not a regular file or a directory" "$T/mf.txt" || bad+=" [symlink: $rc $(tail -1 "$T/mf.txt")]"
rm -rf "$T/rel/data-day-2026-07-22"
grep -q -- "--no-same-owner --no-overwrite-dir" "$here/margin-fetch.sh" || bad+=" [extract flags]"
# ruling 6: 07-23 read at K2, 07-24 at K3. With data-day-2026-07-23-k3 present, 07-24 takes its
# K3 units (never the K2 copy), every unit K3, byte-equal to the -k3 release's own units;
# without it, 07-24 is refused (nothing taken, no prev-units.txt, so scan-day reads nothing).
MFX=$T/fxm3/research/historical/ci
mkmargin data-day-2026-07-23 K2; rm -rf "$T/mfout"; MFX=$MFX mf 2026-07-24
[[ $rc == 1 && ! -e "$T/mfout/units" && ! -e "$T/mfout/prev-units.txt" ]] && grep -q "waits for data-day-2026-07-23-k3" "$T/mf.txt" || bad+=" [K3 day took K2: $rc $(tail -1 "$T/mf.txt")]"
mkmargin data-day-2026-07-23-k3 K3; rm -rf "$T/mfout"; MFX=$MFX mf 2026-07-24
[[ $rc == 0 ]] && grep -qx "1046/3-4 data-day-2026-07-23-k3" "$T/mfout/from-store.txt" || bad+=" [K3 from -k3: $rc $(tail -1 "$T/mf.txt")]"
for st in "$T"/mfout/units/*/*/stats.json; do grep -q '"retention": "K3"' "$st" || bad+=" [not K3: $st]"; done
rm -rf "$T/mfk3"; mkdir -p "$T/mfk3"; tar -xf "$T/rel/data-day-2026-07-23-k3/units-2026-07-23.tar.part00" -C "$T/mfk3"
for u in 3-4 5-6; do for f in stats.json events.jsonl.zst; do cmp -s "$T/mfout/units/1046/$u/$f" "$T/mfk3/units/1046/$u/$f" || bad+=" [$u/$f differs from the -k3 copy]"; done; done
rm -rf "$T/rel/data-day-2026-07-23" "$T/rel/data-day-2026-07-23-k3"; MFX=$MFX mkmargin data-day-2026-07-23 K3; rm -rf "$T/mfout"; MFX=$MFX mf 2026-07-24
[[ $rc == 0 ]] && grep -qx "1046/3-4 data-day-2026-07-23" "$T/mfout/from-store.txt" || bad+=" [K3 plain: $rc]"
rm -rf "$T/rel/data-day-2026-07-23" "$T/rel/data-day-2026-07-23-k3" "$T/mfk3"; unset GH_BIN
# ruling 7: B-10 done for a two-day K3 chain whose second day took a unit from the first
# (its line carries the first day's list sha256, marked "from data-day-<D-1>").
mkchain() { GD="$GD" "$GD/bin/mkrel" 2026-07-24; GD="$GD" "$GD/bin/mkrel" 2026-07-25
  local a=$GD/rel/data-day-2026-07-24 b=$GD/rel/data-day-2026-07-25 as bs
  as=$(sha256sum "$a/list-2026-07-24.txt" | cut -d' ' -f1); bs=$(sha256sum "$b/list-2026-07-25.txt" | cut -d' ' -f1)
  printf '1046/1-4500 r1 K3 %s\n1046/4501-9000 r1 K3 %s\nfrom 1046/4501-9000 %s\n' "$bs" "${FROMSHA:-$as}" "${FROMTAG:-data-day-2026-07-24}" > "$b/units-2026-07-25.log"
  (cd "$b" && rm -f SHA256SUMS-2026-07-25 readback-ok-2026-07-25 && sha256sum -- * > SHA256SUMS-2026-07-25 &&
    printf 'readback-ok data-day-2026-07-25 %s' "$(sha256sum SHA256SUMS-2026-07-25 | cut -d' ' -f1)" > readback-ok-2026-07-25); }
gdreset; printf '2026-07-24\n2026-07-25\n' > "$GD/published"; mkchain; b10
[[ $rc == 0 && "$(tr '\n' ' ' < "$T/b10")" == "2026-07-24 2026-07-25 " ]] || bad+=" [chain: $rc $(tr '\n' ' ' < "$T/b10")]"
v=$(sha256sum "$GD/rel/data-day-2026-07-25/list-2026-07-25.txt" | cut -d' ' -f1); FROMSHA=$v mkchain; b10
[[ $rc == 0 && "$(tr '\n' ' ' < "$T/b10")" == "2026-07-24 " ]] || bad+=" [taken unit with its own day's sha: $(tr '\n' ' ' < "$T/b10")]"
FROMTAG=data-day-2026-07-23 mkchain; b10; [[ "$(tr '\n' ' ' < "$T/b10")" == "2026-07-24 " ]] || bad+=" [from another day counted]"
mkchain; rm "$GD/rel/data-day-2026-07-24/readback-ok-2026-07-24"; b10; [[ ! -s "$T/b10" ]] || bad+=" [from an unmarked release counted: $(tr '\n' ' ' < "$T/b10")]"
gdreset
# ruling 9: a day after the first is read only with the day before's stored units, handed
# to the scanner with the taken ones (the scanner refuses a stored unit that was not taken).
mkfx "$T/fx9"; o="$T/sc9"; rm -rf "$o"; mkdir -p "$o"; rc=0
NOPREV=1 SFX=$T/fx9/research/historical/ci SDAY=2026-07-23 scan "$o" || rc=$?
[[ $rc == 2 && ! -s "$T/calls.log" ]] && grep -q "no list of the day before's stored units" "$T/out.txt" || bad+=" [no prev-units: $rc $(calls)]"
rm -rf "$o"; mkdir -p "$o"; echo "1046/1-4500" > "$o/prev-units.txt"; echo "1046/1-4500 data-day-2026-07-22" > "$o/from-store.txt"; rc=0
SFX=$T/fx9/research/historical/ci SDAY=2026-07-23 scan "$o" || rc=$?
[[ $rc == 0 ]] && grep -q -- "-stored $o/prev-units.txt -taken $o/from-store.txt" "$T/scan.args" || bad+=" [stored args: $rc $(cat "$T/scan.args" 2>/dev/null)]"
rm -rf "$o"; mkdir -p "$o"; rc=0; SFX=$T/fx9/research/historical/ci scan "$o" || rc=$?
[[ $rc == 0 ]] && ! grep -q -- "-stored" "$T/scan.args" || bad+=" [first day: $rc]"
# 3. scan-day: a day holding only D-1's taken (K3) units reads its own at K2, without refusing;
# check-day rescans its first own unit, never a taken one; the trim passes taken units through.
mkfx "$T/fx6"; o="$T/sc6"; rm -rf "$o"; mkdir -p "$o/units/1046/3-4"; printf '{\n  "scanner_revision": "r1",\n  "retention": "K3"\n}\n' > "$o/units/1046/3-4/stats.json"; echo "1046/3-4 data-day-2026-07-22" > "$o/from-store.txt"
rc=0; SFX=$T/fx6/research/historical/ci SDAY=2026-07-23 scan "$o" || rc=$?
[[ $rc == 0 && $(calls) == "scan " ]] && grep -q -- "-retention K2 " "$T/scan.args" || bad+=" [scan with taken units: $rc $(tail -2 "$T/out.txt")]"
o="$T/cd6"; rm -rf "$o"; mkdir -p "$o/units/1046/1-2" "$o/units/1046/3-4" "$o/cache"
for u in 1-2 3-4; do echo x > "$o/units/1046/$u/blocks.csv.zst"; printf '{"blocks": 3, "retention": "K2"}\n' > "$o/units/1046/$u/stats.json"; done
echo "1046/1-2 data-day-2026-07-21" > "$o/from-store.txt"; : > "$T/zs.args"; : > "$T/summary.md"; gpass 2026-07-22 K2; rc=0
ARCHIVE_GO=$T/archive10.go ARCHIVE_GUARD_DIR="$GP" RESCAN_RC=0 RESCAN_COPY=1 FAKE_AVAIL=999000000000 DATASET_PARENT="$T/cd-ds" PATH="$C:$PATH" GITHUB_STEP_SUMMARY="$T/summary.md" \
  bash "$FX/check-day.sh" 2026-07-22 "$o" "$T/cd6-assets" > "$T/out.txt" 2>&1 || rc=$?
grep -q -- "-from-slot 3 -to-slot 4 " "$T/zs.args" && ! grep -q -- "-from-slot 1 " "$T/zs.args" || bad+=" [rescan picked: $rc $(grep '^unit' "$T/zs.args")]"
grep -qx "from 1046/1-2 data-day-2026-07-21" "$T/cd6-assets/units-2026-07-22.log" 2>/dev/null || bad+=" [check-day log from line]"
mkk2; mkdir -p "$T/tk2/units/1046/7-8"; echo '{"scanner_revision": "rF", "retention": "K3", "migration_list_sha256": "other"}' > "$T/tk2/units/1046/7-8/stats.json"; echo taken > "$T/tk2/units/1046/7-8/a.zst"
echo "1046/7-8 data-day-2026-07-21" > "$T/tk2/from-store.txt"; rc=0; td 2026-07-22 - || rc=$?
[[ $rc == 0 && "$(cat "$T/tk2/units/1046/7-8/a.zst" 2>/dev/null)" == taken ]] && ! grep -q -- "-in $T/tk2/units/1046/7-8" "$T/trim.args" && grep -qx "from 1046/7-8 data-day-2026-07-21" "$T/tk2/units.log" || bad+=" [trim pass-through: $rc $(tail -2 "$T/out.txt")]"
[[ -z "$bad" ]] && ok "OF-6 margin: package-day stores margin-DAY.tar (the units reaching the next day) in SHA256SUMS; margin-fetch moves D-1's margin units into D's progress from a done release at D's retention (a K3 day after a K2 day only from data-day-<D-1>-k3, its units byte-equal to that release's, else refused; ruling 6) and lists them in from-store.txt and D-1's stored units in prev-units.txt, takes nothing for the first day, keeps a unit already there, and fails closed on a changed tar, a symlink member (ruling 8), a path outside units/, an unmarked or missing release; B-10 done counts a two-day K3 chain with a taken unit (ruling 7); scan-day reads a later day only with the stored units handed to the scanner (ruling 9); scan-day reads the rest at K2 with taken K3 units present; check-day rescans an own unit and logs from lines; the trim passes taken units through untouched with from lines" || no "OF-6 margin:$bad"
bad=""; gdreset
# 4. The guard pass records whether the day had a counted scan failure since ARCHIVE_REARM_AT.
dsrun 391 "data-scan scan source=archive" failure 300 200 "Archive guard=success,scan (2026-07-22)=failure,continue=failure" | dsjson
rm -rf "$GP"; guard attest 2026-07-22 "$GP"; read -r _ _ _ _ _ fl < "$GP/2026-07-22" 2>/dev/null; [[ "${fl:-}" == 1 ]] || bad+=" [flag after a failure: ${fl:-none} $(tail -2 "$T/gout.txt")]"
gdreset; rm -rf "$GP"; guard attest 2026-07-22 "$GP"; read -r _ _ _ _ _ fl < "$GP/2026-07-22" 2>/dev/null; [[ "${fl:-}" == 0 ]] || bad+=" [flag without: ${fl:-none}]"
# 5. QA-REREAD rows and scan-day: only the named units are read again, at the recorded retention.
dec="$T/fx6/docs/DECISIONS.md"
printf '| 2026-10-08 | QA-REREAD id=rr-1 day=2026-07-22 units=1046/1-2,1046/3-4 toldAt=2026-10-08T00:00:00Z | t | t |\n| 2026-10-08 | QA-REREAD id=rr-t day=2026-07-23 units=1046/3-4 toldAt=2026-10-08T00:00:00Z | t | t |\n| 2026-10-08 | QA-REREAD id=rr-f day=2026-07-22 units=1046/1-2 toldAt=2099-01-01T00:00:00Z | t | t |\n| 2026-10-08 | QA-REREAD id=rr-b day=2026-07-22 units=1046/1-2;rm toldAt=2026-10-08T00:00:00Z | t | t |\n' >> "$dec"
rr() { rc=0; (. "$T/fx6/research/historical/ci/archive-guard.sh"; ag_summary=/dev/null; ag_reread "$1" "$2") > "$T/rr.out" 2>&1 || rc=$?; }
rr rr-1 2026-07-22; [[ $rc == 0 && "$(cat "$T/rr.out")" == $'1046/1-2\n1046/3-4' ]] || bad+=" [row: $rc $(cat "$T/rr.out")]"
rr rr-1 2026-07-23; [[ $rc == 2 ]] || bad+=" [other day: $rc]"
rr rr-9 2026-07-22; [[ $rc == 2 ]] || bad+=" [no row: $rc]"
rr rr-f 2026-07-22; [[ $rc == 2 ]] || bad+=" [future told: $rc]"
rr rr-b 2026-07-22; [[ $rc == 2 ]] || bad+=" [bad units: $rc]"
mk6() { rm -rf "$1"; for u in 1-2 3-4 5-6; do mkdir -p "$1/units/1046/$u"; printf '{\n  "scanner_revision": "r1",\n  "retention": "%s"\n}\n' "$2" > "$1/units/1046/$u/stats.json"; echo "$u" > "$1/units/1046/$u/a.zst"; done; }
o="$T/rr6"; mk6 "$o" K2
rc=0; ARCHIVE_REREAD_ID=rr-1 SFX=$T/fx6/research/historical/ci scan "$o" || rc=$?
[[ $rc == 0 && $(calls) == "scan " ]] && grep -q -- "-retention K2 -units $o/reread.units " "$T/scan.args" && [[ "$(cat "$o/reread.units")" == $'1046/1-2\n1046/3-4' && ! -e "$o/units/1046/1-2" && ! -e "$o/units/1046/3-4" && -f "$o/units/1046/5-6/a.zst" ]] || bad+=" [K2 reread: $rc $(tail -2 "$T/out.txt")]"
o="$T/rr6k3"; mk6 "$o" K3; echo "pool 1 2" > "$o/list-2026-07-22.txt"
{ for u in 1-2 3-4 5-6; do echo "1046/$u r1 K3 x"; done; for u in 1-2 3-4 5-6; do echo "k2 $(h $u) 1046/$u/a.zst"; done; } > "$o/units.log"
rc=0; ARCHIVE_REREAD_ID=rr-1 SFX=$T/fx6/research/historical/ci scan "$o" || rc=$?
[[ $rc == 0 ]] && grep -q -- "-retention K3 -migration-list $o/list-2026-07-22.txt -units $o/reread.units " "$T/scan.args" || bad+=" [K3 reread: $rc $(tail -2 "$T/out.txt")]"
[[ "$(grep -c '^k2 ' "$o/units.log")" == 1 ]] && grep -q "^k2 .* 1046/5-6/a.zst$" "$o/units.log" && grep -qx "reread 1046/1-2 rr-1" "$o/units.log" && grep -qx "reread 1046/3-4 rr-1" "$o/units.log" || bad+=" [K3 log: $(tr '\n' '|' < "$o/units.log")]"
o="$T/rr6n"; mk6 "$o" K2; rc=0; ARCHIVE_REREAD_ID=rr-9 SFX=$T/fx6/research/historical/ci scan "$o" || rc=$?
[[ $rc == 2 && ! -s "$T/calls.log" && -d "$o/units/1046/1-2" ]] || bad+=" [no row: $rc]"
o="$T/rr6t"; mk6 "$o" K2; echo "1046/3-4 data-day-2026-07-22" > "$o/from-store.txt"; rc=0; ARCHIVE_REREAD_ID=rr-t SFX=$T/fx6/research/historical/ci SDAY=2026-07-23 scan "$o" || rc=$?
[[ $rc == 2 && ! -s "$T/calls.log" ]] && grep -q "taken from the day before's store; it is never read again" "$T/out.txt" || bad+=" [taken reread: $rc]"
# 6. A whole-day re-read of a failed day is refused; a resume of its saved progress is not.
o="$T/rr6w"; rm -rf "$o"; mkdir -p "$o"; rc=0; GFAILED=1 SFX=$T/fx6/research/historical/ci scan "$o" || rc=$?
[[ $rc == 2 && ! -s "$T/calls.log" ]] && grep -q "a whole-day re-read is refused" "$T/out.txt" || bad+=" [whole day: $rc]"
o="$T/rr6r"; mk6 "$o" K2; rc=0; GFAILED=1 SFX=$T/fx6/research/historical/ci scan "$o" || rc=$?
[[ $rc == 0 && $(calls) == "scan " ]] || bad+=" [resume: $rc]"
[[ -z "$bad" ]] && ok "OF-6 re-read: the guard pass flags a day with a counted scan failure; a QA-REREAD row is used only for its day, with a past toldAt and well-formed units; scan-day then reads exactly the named units (deleted first, the rest kept) at the recorded retention (K3 with the day's list, the per-unit log marking them reread instead of k2 lines); no row, or a unit taken from the store, reads nothing; a fresh whole-day read of a failed day is refused while a resume of its progress runs" || no "OF-6 re-read:$bad"
bad=""; gdreset

echo "$pass passed, $fail failed"
(( fail == 0 ))
