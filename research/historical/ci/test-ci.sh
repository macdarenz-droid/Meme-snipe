#!/usr/bin/env bash
# Offline tests for assemble.sh and scan-day.sh: gh, df, zeroed-scan, node and sleep are
# PATH stubs (gh over a fake release store), so no network is used and nothing waits.   bash research/historical/ci/test-ci.sh
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
T=$(mktemp -d)
trap 'rm -rf "$T"' EXIT
export T GITHUB_REPOSITORY=test/repo GITHUB_SHA=abc123 FAKE_AVAIL=999999999999999
mkdir -p "$T/bin" "$T/rel"
pass=0 fail=0
ok() { echo "ok   $1"; pass=$((pass + 1)); }
no() { echo "FAIL $1"; fail=$((fail + 1)); }

# ---- stubs ----
cat > "$T/bin/gh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
[[ "$1" == release ]] || exit 2
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
    [[ -n "${FAKE_GH_DOWNLOAD_FAIL:-}" ]] && { echo "HTTP 502" >&2; exit 1; }
    echo "$tag" >> "$T/downloads.log"
    out="" pats=()
    while (( $# )); do
      case "$1" in --dir) out=$2; shift ;; --pattern) pats+=("$2"); shift ;; esac; shift
    done
    for p in "${pats[@]}"; do for f in "$dir"/$p; do [[ -e "$f" ]] && cp "$f" "$out/"; done; done ;;
  create)
    mkdir "$dir"; echo "$tag" >> "$T/created.log"
    while (( $# )) && [[ "$1" != -- ]]; do shift; done
    (( $# )) && { shift; (( $# )) && cp -- "$@" "$dir/"; }
    true ;;
  upload)
    clob=; while (( $# )) && [[ "$1" != -- ]]; do [[ "$1" == --clobber ]] && clob=1; shift; done; shift
    [[ -d "$dir" ]] || { echo "release not found" >&2; exit 1; }
    [[ -n "${FAKE_GH_UPLOAD_FAIL:-}" ]] && { echo "HTTP 502" >&2; exit 1; }
    for f in "$@"; do [[ "$(basename "$f")" == "${FAKE_GH_FAIL_ASSET:-}" ]] && { echo "HTTP 502" >&2; exit 1; }; done
    # gh's --clobber deletes the old asset first, then uploads: this fails after the delete
    if [[ -n "$clob" && -n "${FAKE_GH_CLOBBER_FAIL:-}" ]]; then for f in "$@"; do rm -f -- "$dir/$(basename "$f")"; done; echo "HTTP 502" >&2; exit 1; fi
    if [[ -z "$clob" ]]; then for f in "$@"; do [[ -e "$dir/$(basename "$f")" ]] && { echo "asset under the same name already exists" >&2; exit 1; }; done; fi
    cp -- "$@" "$dir/" ;;
  delete-asset)
    [[ "$1" == "${FAKE_GH_DELETE_FAIL_ASSET:-}" ]] && { echo "HTTP 502" >&2; exit 1; }
    rm -- "$dir/$1" ;;
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
  (cd "$dir" && sha256sum units-"$day".tar.part* events-"$day".tar > "SHA256SUMS-$day")
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
run() { bash "$here/assemble.sh" "$@" > "$T/out.txt" 2>&1; }

# ---- 1. full offline run: FROM 09-20, TO 09-22, lead-in 09-06 .. 09-19 ----
reset_store
if run 2026-09-20 2026-09-22 "$T/work"; then ok "assemble runs end to end"; else no "assemble runs end to end"; cat "$T/out.txt"; fi
dl=$(sort "$T/downloads.log" | tr '\n' ' ')
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

reset_store
FAKE_AVAIL=1000 run 2026-09-20 2026-09-22 "$T/work" && no "disk guard passed" || { grep -q "not enough disk" "$T/out.txt" && ok "free-space guard (3x tar + 10 GB)" || no "disk guard message"; }

reset_store; echo junk >> "$T/rel/data-day-2026-09-21/units-2026-09-21.tar.part00"
run 2026-09-20 2026-09-22 "$T/work" && no "corrupt part accepted" || { grep -q "checksum mismatch" "$T/out.txt" && ok "corrupt window part fails the checksum" || no "checksum message: $(cat "$T/out.txt")"; }
reset_store; echo junk >> "$T/rel/data-day-2026-09-08/events-2026-09-08.tar"
run 2026-09-20 2026-09-22 "$T/work" && no "corrupt events asset accepted" || { grep -q "events asset checksum mismatch" "$T/out.txt" && ok "corrupt lead-in events asset fails the checksum" || no "events checksum message: $(cat "$T/out.txt")"; }
reset_store; rm "$T/rel/data-day-2026-09-10/units-2026-09-10.tar.part"*
run 2026-09-20 2026-09-22 "$T/work"; grep -q "^data-day-2026-09-10$" "$T/downloads.log" && ! ls "$T/work"/dl-* >/dev/null 2>&1 && [[ -f "$T/rel/data-2026-09-20-2026-09-22/manifest.json" || -f "$T/finalize.args" ]] &&
  ok "lead-in days download only the events asset (a lead-in day with no tar parts still assembles)" || no "lead-in events-only: $(tail -3 "$T/out.txt")"

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

# ---- 3. scan-day.sh: shared back-off (zeroed-scan and sleep stubs record each call) ----
S="$T/sbin"; mkdir -p "$S"
cat > "$S/zeroed-scan" <<'STUB'
#!/usr/bin/env bash
# first call exits FIRST_RC (75: a 429 with a 10 s back-off in the state), later calls 0
echo scan >> "$T/calls.log"
while (( $# )); do [[ "$1" == -out ]] && out=$2; shift; done
# SLOW: a scan that outlasts the budget; interrupted (SIGINT) it exits 1 like the scanner
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
scan() {
  : > "$T/calls.log"
  PATH="$S:$PATH" GITHUB_STEP_SUMMARY="$T/summary.md" bash "$here/scan-day.sh" 2026-09-20 "$1" 80 "${2:-300}" > "$T/out.txt" 2>&1
}
calls() { tr '\n' ' ' < "$T/calls.log"; }
o="$T/scan1"; mkdir -p "$o"; now=$(date +%s); echo "$((now - 5)) 600 $((now + 120))" > "$o/archive-429.state"
if scan "$o"; then
  mapfile -t c < "$T/calls.log"; w=${c[0]#sleep }
  [[ ${#c[@]} == 2 && "${c[0]}" == sleep* && "${c[1]}" == scan ]] && (( w >= 110 && w <= 120 )) &&
    ok "scan-day honours an existing back-off: waits until its end (${w} s) before the first scan" || no "existing back-off: $(calls)"
else no "scan-day with an existing back-off: $(cat "$T/out.txt")"; fi
o="$T/scan2"; mkdir -p "$o"; : > "$T/summary.md"
if FIRST_RC=75 scan "$o"; then
  mapfile -t c < "$T/calls.log"; w=${c[1]#sleep }
  [[ ${#c[@]} == 3 && "${c[0]}" == scan && "${c[1]}" == sleep* && "${c[2]}" == scan ]] && (( w >= 3600 )) &&
    ok "after scanner exit 75 the wait is >= 3600 s (${w} s), then the same lane resumes" || no "429 wait: $(calls)"
  grep -q "429 from archive" "$T/summary.md" && ls "$o"/429-*.log >/dev/null 2>&1 &&
    ok "429 log goes to the summary and is kept" || no "429 log"
else no "scan-day after a 429: $(cat "$T/out.txt")"; fi
o="$T/scan3"; mkdir -p "$o"; now=$(date +%s); echo "$now 7200 $((now + 7200))" > "$o/archive-429.state"
rc=0; scan "$o" 60 || rc=$?
mapfile -t c < "$T/calls.log"; w=${c[0]#sleep }
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

# ---- scan-day.sh: cached units of another scanner revision are rescanned ----
o="$T/scanrev"; mkdir -p "$o/units/1047/1-2" "$o/units/1047/3-4" "$o/units/1047/5-6"
printf '{\n  "scanner_revision": "rOld"\n}\n' > "$o/units/1047/1-2/stats.json"
printf '{\n  "scanner_revision": "rNew"\n}\n' > "$o/units/1047/3-4/stats.json"
mkdir -p "$o/units/1047/7-8"; printf '{\n  "blocks": 3\n}\n' > "$o/units/1047/7-8/stats.json"
: > "$T/calls.log"
SCANNER_REVISION=rNew PATH="$S:$PATH" GITHUB_STEP_SUMMARY="$T/summary.md" bash "$here/scan-day.sh" 2026-09-20 "$o" 80 300 > "$T/out.txt" 2>&1
[[ ! -d "$o/units/1047/1-2" && ! -d "$o/units/1047/7-8" && -d "$o/units/1047/3-4" && -d "$o/units/1047/5-6" ]] && grep -q "rescanning it" "$T/summary.md" &&
  ok "scan-day: cached units of another revision or with no scanner_revision are dropped and rescanned, the rest kept" || no "scan-day revision drop"

# ---- publish-day.sh: one day, one create call, existing releases checked, never edited ----
export GH_BIN="$T/bin/gh"
pd="$T/pd"; mkdir -p "$pd"; rm -rf "$T/rel/data-day-2026-09-30"; : > "$T/created.log"
mkpd() {
  rm -f "$pd"/*
  for f in units-2026-09-30.tar.part00 units-2026-09-30.tar.part01 events-2026-09-30.tar qa-2026-09-30.md qa-2026-09-30.json manifest-2026-09-30.json parity-2026-09-30.json; do echo "$f" > "$pd/$f"; done
  (cd "$pd" && sha256sum units-* events-* qa-* manifest-* parity-* > SHA256SUMS-2026-09-30)
}
mkpd
bash "$here/publish-day.sh" 2026-09-30 "$pd" >/dev/null && [[ $(ls "$T/rel/data-day-2026-09-30" | wc -l) == 8 ]] &&
  ok "publish-day: release data-day-DAY created with parts, QA, manifest, parity and sums" || no "publish-day create"
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
python3 - "$here/../../../.github/workflows/data-scan.yml" <<'PY' && ok "workflow: every step after the published check (scan, QA, publish) is skipped for a complete day; token only in the check, publish and Helius ledger steps, all in a clean shell; a resumable stop chains the next run, bounded, only after a saved progress; QA starts only with 45 min left" || no "workflow skip/token structure"
import sys, yaml
steps = yaml.safe_load(open(sys.argv[1]))["jobs"]["scan"]["steps"]
i = next(k for k, s in enumerate(steps) if s.get("id") == "published")
names = [s.get("name", s.get("uses", "")) for s in steps]
assert all("Scan" not in n and "Build" not in n for n in names[:i]), names[:i]
for s in steps[i + 1:]:
    if "setup-node" in s.get("uses", ""):
        continue
    assert "steps.published.outputs.complete != 'true'" in s.get("if", ""), s
tok = [s for s in steps if "github.token" in str(s)]
assert [s.get("id") or s.get("name") for s in tok] == ["published", "reserve", "Settle Helius credits", "Publish this day", "Publish this day's volume hours"], tok
for s in tok:
    assert s["shell"].startswith("/usr/bin/env -u BASH_ENV -u ENV /usr/bin/bash --noprofile --norc"), s
    # only absolute paths before the env -i call: the reserve step first clears old spend markers
    run = "\n".join(l for l in s["run"].splitlines() if not l.startswith("#") and not l.startswith("/usr/bin/rm -f "))
    assert s["env"]["BASH_ENV"] == "" and run.startswith("/usr/bin/env -i PATH=/usr/bin:/bin "), s
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
assert c["permissions"] == {"actions": "write"} and int(c["env"]["MAX_CHAIN"]) <= 12, c
assert len(c["steps"]) == 1 and "uses" not in c["steps"][0], c
r = c["steps"][0]["run"]
assert r.index('select(startswith("resume-"))') < r.index('-ge "$MAX_CHAIN"') < r.index("gh workflow run"), r
assert '-f chain="$next"' in r and "-f days=\"$DAYS\"" in r, r
assert wf[True]["workflow_dispatch"]["inputs"]["chain"]["default"] == "0"
# volume back-fill: its own concurrency group, no archive access, token in two steps only,
# publishing in the same clean shell as the day release
assert wf["concurrency"]["group"] == "${{ inputs.mode == 'volume' && 'data-scan-volume' || 'data-scan' }}", wf["concurrency"]
vj = wf["jobs"]["volume"]
assert vj["if"] == "inputs.mode == 'volume'" and vj["strategy"]["max-parallel"] == 1, vj
vsteps = vj["steps"]
assert not any("scan-day.sh" in str(st) or "zeroed-scan run" in str(st) or "zeroed-scan unit" in str(st) for st in vsteps), "the back-fill must not read the archive"
vtok = [st["name"] for st in vsteps if "github.token" in str(st)]
assert vtok == ["Download the day's units", "Publish the volume hours"], vtok
dl = next(st for st in vsteps if st.get("name") == "Download the day's units")
assert "volume-day.sh --download" in dl["run"] and "zeroed-scan" not in dl["run"] and "node" not in dl["run"], dl
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
assert order("save") < order("qatime") < order("qa") < order("Package the day") < order("Publish this day")
for k in ("qa", "Package the day", "Publish this day"):
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
# phase durations: artifact upload and publish timed around their steps
day_up = next(i for i, st in enumerate(steps) if st.get("with", {}).get("name") == "day-${{ matrix.day }}")
assert order("Note the upload start") < day_up < order("Note the publish start") < order("Publish this day") < order("Log the publish duration")
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
python3 - "$here/../../../.github/workflows/data-helius-pilot.yml" <<'PY' && ok "helius pilot workflow: dispatch only, the token only in the two ledger steps (clean shell, no key), credit stop checked first (at most 15000), HELIUS_API_KEY only in the pilot step's env, inputs only through env, only the report uploaded" || no "helius pilot workflow structure"
import sys, yaml
wf = yaml.safe_load(open(sys.argv[1]))
assert list(wf[True].keys()) == ["workflow_dispatch"], wf[True]
assert wf["permissions"] == {"contents": "read"}, wf["permissions"]
assert wf["jobs"]["pilot"]["permissions"] == {"contents": "write"}, wf["jobs"]["pilot"]
steps = wf["jobs"]["pilot"]["steps"]
assert steps[0]["name"] == "Check the credit stop" and "MAX_CREDITS > 15000" in steps[0]["run"], steps[0]
for st in steps:
    if "checkout" in st.get("uses", ""):
        assert st["with"]["persist-credentials"] is False, st
    assert "${{" not in st.get("run", ""), st  # inputs and secrets reach the shell only through env
sec = [st for st in steps if "secrets." in str(st)]
assert len(sec) == 1 and sec[0]["env"] == {"HELIUS_API_KEY": "${{ secrets.HELIUS_API_KEY }}"}, sec
r = sec[0]["run"]
assert "zeroed-rpcscan pilot" in r and '-max-credits "$MAX_CREDITS"' in r and "-sample 0.05" in r and "HELIUS_API_KEY" not in r, r
# DATA-4: the pilot spends only its ledger reservation, with a start marker before it
assert r.index('MAX_CREDITS=$(cat "$RUNNER_TEMP/rpc-reservation")') < r.index('rpc-started-pilot') < r.index("zeroed-rpcscan pilot"), r
names = [st.get("name") for st in steps]
assert names.index("Reserve Helius credits") < names.index("Pilot (free plan, hard credit stop)") < names.index("Settle Helius credits"), names
tok = [st for st in steps if "github.token" in str(st)]
assert [st["name"] for st in tok] == ["Reserve Helius credits", "Settle Helius credits"], tok
for st in tok:
    assert st["shell"].startswith("/usr/bin/env -u BASH_ENV -u ENV /usr/bin/bash --noprofile --norc") and "/usr/bin/env -i PATH=/usr/bin:/bin " in st["run"], st
    assert "rpc-ledger.sh" in st["run"] and "secrets." not in str(st), st
assert "always()" in tok[1]["if"] and "steps.reserve.outcome != 'skipped'" in tok[1]["if"], tok[1]
assert all('GITHUB_STEP_SUMMARY="$GITHUB_STEP_SUMMARY"' in st["run"] for st in tok), tok
up = [st for st in steps if "upload-artifact" in st.get("uses", "")]
assert len(up) == 1 and up[0]["with"]["path"].endswith("/report/pilot-report.json"), up
PY

# ---- check-day.sh: phase durations; a 429 in the determinism rescan is resumable (75) ----
C="$T/cdbin"; mkdir -p "$C"
cat > "$C/zeroed-scan" <<'STUB'
#!/usr/bin/env bash
# finalize: an empty dataset with its manifest; unit (determinism rescan): exit RESCAN_RC
if [[ $1 == finalize ]]; then
  while (( $# )); do [[ "$1" == -dataset ]] && ds=$2; shift; done
  mkdir -p "$ds/qa"; echo '{}' > "$ds/manifest.json"; exit 0
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
cdrun() {
  local o="$T/cd-$1"; rm -rf "$o"; mkdir -p "$o/units/1046/1-2" "$o/cache" "$T/cd-ds"; echo x > "$o/units/1046/1-2/blocks.csv.zst"
  : > "$T/summary.md"
  RESCAN_RC=$2 FAKE_AVAIL=999000000000 DATASET_PARENT="$T/cd-ds" PATH="$C:$PATH" GITHUB_STEP_SUMMARY="$T/summary.md" \
    bash "$here/check-day.sh" 2026-09-20 "$o" "$T/cd-assets-$1" > "$T/out.txt" 2>&1
}
rc=0; cdrun a 75 || rc=$?
[[ $rc == 75 ]] && grep -q "429 during the determinism rescan" "$T/summary.md" &&
  ok "check-day: a 429 in the determinism rescan exits 75 (resumable) with a summary line" || no "check-day 429: rc=$rc $(cat "$T/out.txt")"
for p in finalize qa parity volume determinism; do grep -q "^phase $p (2026-09-20): [0-9]* s$" "$T/summary.md" || { no "check-day: no duration for $p"; break; }; done
[[ $p == determinism ]] && grep -q "^phase determinism" "$T/summary.md" && ok "check-day: finalize, QA, parity, volume and determinism durations are logged"
rc=0; cdrun b 1 || rc=$?
[[ $rc == 1 ]] && grep -q "determinism rescan failed (scanner exit 1)" "$T/summary.md" && ok "check-day: any other rescan failure exits 1 (not resumable)" || no "check-day rescan failure: rc=$rc"

# ---- rpc-day.sh / check-day.sh (source helius): spend only the run's ledger reservation ----
R="$T/rpcbin"; mkdir -p "$R"
cat > "$R/zeroed-rpcscan" <<'STUB'
#!/usr/bin/env bash
# rpc-run / rpc-unit stand-in: logs its arguments, writes RPC_CREDITS into -usage-out
# ("final" when RPC_FINAL is set), sleeps RPC_SLEEP (interruptible: SIGINT writes the
# usage and exits 1), exits RPC_RC.
echo "$*" >> "$RPCLOG"
u=; while (( $# )); do [[ $1 == -usage-out ]] && u=$2; shift; done
w() { [[ -n "$u" && -z "${RPC_NOUSAGE:-}" ]] || return 0
  printf '{\n  "credits": %s,\n  "requests": 1,\n  "final": %s\n}\n' "${RPC_CREDITS:-0}" "${RPC_FINAL:-false}" > "$u"; }
trap 'w; exit 1' INT
[[ -n "${RPC_SLEEP:-}" ]] && { sleep "$RPC_SLEEP" & wait $!; }
w; exit "${RPC_RC:-0}"
STUB
chmod +x "$R/zeroed-rpcscan"
rd() { local o=$1; shift; : > "$T/summary.md"; env RPCLOG="$T/rpc.log" PATH="$R:$PATH" GITHUB_STEP_SUMMARY="$T/summary.md" "$@" \
  bash "$here/rpc-day.sh" 2026-09-21 "$o" "${RD_BUDGET:-5}" "${RD_CREDITS:-1000}" > "$T/out.txt" 2>&1; }
o="$T/rd1"; rm -rf "$o" "$T/rpc.log"
rc=0; rd "$o" RPC_CREDITS=100 RPC_FINAL=true RPC_RC=75 || rc=$?
[[ $rc == 75 && -e "$o/rpc-started-scan" ]] && grep -q -- "-max-credits 1000 -usage-out $o/rpc-usage-scan.json" "$T/rpc.log" && grep -q -- "-from 2026-09-21 -to 2026-09-22 " "$T/rpc.log" &&
  ok "rpc-day: spends at most the run's reservation, marks the start before spending, and a back-off stop exits 75 (resumable)" || no "rpc-day 75: rc=$rc $(cat "$T/out.txt")"
rc=0; rd "$o" RPC_CREDITS=1000 RPC_FINAL=true RPC_RC=3 || rc=$?
[[ $rc == 3 ]] && grep -q "reserved credits are spent while reading" "$T/summary.md" && ok "rpc-day: the reservation spent mid-run exits 3 (not resumable)" || no "rpc-day cap: rc=$rc"
n=$(wc -l < "$T/rpc.log"); rc=0; RD_CREDITS=0 rd "$o" || rc=$?
[[ $rc == 3 && $(wc -l < "$T/rpc.log") == "$n" ]] && ok "rpc-day: with nothing reserved, no request is made (exit 3)" || no "rpc-day spent: rc=$rc"
o="$T/rd2"; rm -rf "$o"; mkdir -p "$o/units/1046/1-2"; echo '{"scanner_revision": "old"}' > "$o/units/1046/1-2/stats.json"
rc=0; rd "$o" SCANNER_REVISION=new RPC_CREDITS=1 || rc=$?
[[ $rc == 0 && ! -e "$o/units/1046/1-2" ]] && ok "rpc-day: units of another revision are reread" || no "rpc-day revision"
o="$T/rd3"; rm -rf "$o"; t0=$(date +%s); rc=0; RD_BUDGET=2s rd "$o" RPC_SLEEP=30 RPC_CREDITS=7 RPC_FINAL=true || rc=$?
[[ $rc == 75 ]] && (( $(date +%s) - t0 < 20 )) && grep -Eq '"final": ?true' "$o/rpc-usage-scan.json" &&
  ok "rpc-day: at the time budget the read is interrupted and exits 75 with its usage written" || no "rpc-day budget: rc=$rc $(cat "$T/out.txt")"
o="$T/rd5"; rm -rf "$o"; rc=0; rd "$o" RPC_CREDITS=100 RPC_FINAL=true RPC_RC=75 || rc=$?; rd "$o" RPC_NOUSAGE=1 RPC_RC=75 || true
[[ ! -e "$o/rpc-usage-scan.json" && -e "$o/rpc-started-scan" ]] && ok "rpc-day: an earlier run's usage file is removed before spending, so a run that writes none is never settled with it" || no "rpc-day stale usage"
# check-day, source helius: the determinism rescan goes over RPC within what is left of the reservation
cdh() {
  local o="$T/cdh-$1"; rm -rf "$o"; mkdir -p "$o/units/1046/1-2" "$T/cd-ds"; echo x > "$o/units/1046/1-2/blocks.csv.zst"
  [[ -n "${2:-}" ]] && printf '%s' "$2" > "$o/rpc-usage-scan.json"
  : > "$T/summary.md"; rm -f "$T/rpc.log"
  env SOURCE=helius RPC_RESERVATION=500 RPCLOG="$T/rpc.log" FAKE_AVAIL=999000000000 DATASET_PARENT="$T/cd-ds" PATH="$R:$C:$PATH" GITHUB_STEP_SUMMARY="$T/summary.md" "${@:3}" \
    bash "$here/check-day.sh" 2026-09-20 "$o" "$T/cdh-assets-$1" > "$T/out.txt" 2>&1
}
rc=0; cdh a '{"credits": 200, "final": true}' RPC_CREDITS=40 RESCAN_RC=1 || rc=$?
[[ -e "$T/cdh-a/rpc-started-rescan" ]] && grep -q -- "rpc-unit .*-epoch 1046 -from-slot 1 -to-slot 2 .*-max-credits 300 -usage-out $T/cdh-a/rpc-usage-rescan.json" "$T/rpc.log" &&
  ok "check-day (helius): the determinism rescan is an RPC rpc-unit within what is left of the reservation after the scan's final spend, start marked" || no "check-day helius rescan: rc=$rc $(cat "$T/rpc.log" 2>/dev/null) $(tail -3 "$T/out.txt")"
rc=0; cdh b '{"credits": 200, "final": false}' || rc=$?
[[ $rc == 3 && ! -s "$T/rpc.log" ]] && ok "check-day (helius): a scan spend that is not final counts as the whole reservation: no rescan request, exit 3" || no "check-day helius non-final: rc=$rc"
rc=0; cdh c '{"credits": 500, "final": true}' || rc=$?
[[ $rc == 3 && ! -s "$T/rpc.log" ]] && ok "check-day (helius): with the reservation spent, no rescan request and exit 3" || no "check-day helius cap: rc=$rc"
rc=0; cdh d '{"credits": 0, "final": true}' RPC_RC=75 || rc=$?
[[ $rc == 75 ]] && grep -q "RPC rate-limit back-off ran out during the determinism rescan" "$T/summary.md" && ok "check-day (helius): an RPC back-off stop in the rescan is resumable (75)" || no "check-day helius 75: rc=$rc"

# helius-ledger.yml's init, run as written: only worker_budget 700000 reaches the ledger.
HY="$T/hly"; rm -rf "$HY"; mkdir -p "$HY/ws/research/historical/ci"
printf '#!/usr/bin/bash\necho "ledger-called $*"\n' > "$HY/ws/research/historical/ci/rpc-ledger.sh"
python3 - "$here/../../../.github/workflows/helius-ledger.yml" > "$HY/run.sh" <<'PY'
import sys, yaml
st = [s for s in yaml.safe_load(open(sys.argv[1]))["jobs"]["ledger"]["steps"] if s.get("name") == "Ledger"][0]
print(st["run"])
PY
hl() { env -i PATH=/usr/bin:/bin HOME="$HOME" ACTION=init PERIOD=2026-10 LIMIT=1000000 USED=100 DAYS="" WORKER_BUDGET=$1 GITHUB_WORKSPACE="$HY/ws" GITHUB_STEP_SUMMARY="$HY/sum" bash "$HY/run.sh" 2>&1; }
o1=$(hl 408000) && no "helius-ledger.yml accepted worker_budget 408000" ||
  { [[ "$o1" == *"worker_budget must be 700000"* && "$o1" != *ledger-called* ]] && o2=$(hl 700000) && [[ "$o2" == *"ledger-called init 2026-10 1000000 700000 100"* ]] &&
    ok "helius-ledger.yml init: worker_budget 408000 is refused before the ledger, 700000 passes" || no "helius-ledger.yml worker_budget: $o1 / ${o2:-}"; }
# ---- rpc-ledger.sh: the account-wide credit ledger (DATA-4) ----
export GH_BIN="$T/bin/gh"
L="$T/ledger"; mkdir -p "$L"; rm -rf "$T/rel/helius-ledger"
led() { env LOCK_WAIT=0 LOCK_POLL=1 "$@"; }
lj() { python3 -c 'import json,sys; l=json.load(open(sys.argv[1])); print(eval(sys.argv[2]))' "$T/rel/helius-ledger/ledger.json" "$1"; }
rc=0; led bash "$here/rpc-ledger.sh" reserve r0 2026-09-20 500 500 "$L/res" 2>"$L/err" || rc=$?
[[ $rc == 1 && ! -e "$L/res" ]] && grep -q "refusing to spend credits" "$L/err" && ok "rpc-ledger: no ledger: reserve fails closed (exit 1, nothing reserved)" || no "rpc-ledger missing: rc=$rc $(cat "$L/err")"
mkdir -p "$T/rel/helius-ledger"; echo '{"period": "x"' > "$T/rel/helius-ledger/ledger.json"
rc=0; led bash "$here/rpc-ledger.sh" reserve r0 2026-09-20 500 500 "$L/res" 2>"$L/err" || rc=$?
[[ $rc == 1 && ! -e "$L/res" && ! -e "$T/rel/helius-ledger/ledger.lock" ]] && ok "rpc-ledger: an unreadable ledger fails closed, and the lock is released" || no "rpc-ledger unreadable: rc=$rc $(cat "$L/err")"
rm -f "$T/rel/helius-ledger/ledger.json"; echo held > "$T/rel/helius-ledger/ledger.lock"
rc=0; led bash "$here/rpc-ledger.sh" init 2026-10 700700 700000 100 2>/dev/null || rc=$?
[[ $rc == 1 && ! -e "$T/rel/helius-ledger/ledger.json" ]] && ok "rpc-ledger: init waits for the lock too (fails closed while another job holds it)" || no "rpc-ledger init lock: rc=$rc"
rm -rf "$T/rel/helius-ledger"
for wb in 699999 408000 700001; do
  rc=0; led bash "$here/rpc-ledger.sh" init 2026-10 1000000 $wb 100 2>"$L/err" || rc=$?
  [[ $rc == 1 && ! -e "$T/rel/helius-ledger/ledger.json" ]] && grep -q "is not the worker's own halt of 700000" "$L/err" &&
    ok "rpc-ledger: init refuses worker share $wb (only the worker's own 700000 halt)" || no "rpc-ledger init worker $wb: rc=$rc $(cat "$L/err")"
done
led bash "$here/rpc-ledger.sh" init 2026-10 700700 700000 100 2026-09-21=100 > "$L/init" &&
  grep -qx "rpc-ledger: the live worker's Helius halt must be exactly 700000 credits (the worker share held back here)" "$L/init" && [[ $(lj 'l["used"], l["days"]') == "(100, {'2026-09-21': 100})" ]] &&
  ! led bash "$here/rpc-ledger.sh" init 2026-10 800000 700000 2>/dev/null && [[ $(lj 'l["worker_budget"]') == 700000 ]] &&
  ok "rpc-ledger: init creates the ledger with what was spent before it; a second init is refused" || no "rpc-ledger init"
# The day cap counts what the day already used and what it holds reserved.
rc=0; led bash "$here/rpc-ledger.sh" reserve rD 2026-09-21 150 800 "$L/rD" >/dev/null || rc=$?
rcE=0; led bash "$here/rpc-ledger.sh" reserve rE 2026-09-21 150 800 "$L/rE" >/dev/null 2>&1 || rcE=$?
mkdir -p "$L/wD"; led bash "$here/rpc-ledger.sh" settle rD "$L/wD" >/dev/null
[[ $rc == 0 && $(cat "$L/rD") == 50 && $rcE == 3 && $(lj 'l["used"], l["outstanding"]') == "(100, [])" ]] &&
  ok "rpc-ledger: a day's cap counts its earlier use (150 - 100 = 50) and its open reservations (then none left: exit 3)" || no "rpc-ledger day cap: $rc $rcE $(cat "$L/rD" 2>/dev/null)"
rc=0; led bash "$here/rpc-ledger.sh" reserve r1 2026-09-20 500 800 "$L/r1" >/dev/null || rc=$?
rc2=0; led bash "$here/rpc-ledger.sh" reserve r2 2026-09-19 900 800 "$L/r2" >/dev/null || rc2=$?
rc3=0; led bash "$here/rpc-ledger.sh" reserve r3 2026-09-18 900 800 "$L/r3" >/dev/null 2>&1 || rc3=$?
[[ $rc == 0 && $(cat "$L/r1") == 500 && $rc2 == 0 && $(cat "$L/r2") == 100 && $rc3 == 3 && ! -e "$L/r3" ]] &&
  ok "rpc-ledger: reservations take the least of the run budget, the day cap and the month after the worker's share (500, then 100 of 700700 - 700000 - 100), then exit 3" || no "rpc-ledger reserve: $rc $rc2 $rc3 $(cat "$L/r1" "$L/r2" 2>/dev/null)"
rc=0; led bash "$here/rpc-ledger.sh" reserve r1 2026-09-20 500 1 "$L/rx" 2>/dev/null || rc=$?
[[ $rc == 1 ]] && ok "rpc-ledger: an id already holding a reservation is refused" || no "rpc-ledger duplicate id: rc=$rc"
w="$L/w1"; mkdir -p "$w"; : > "$w/rpc-started-scan"; echo '{"credits": 120, "final": true}' > "$w/rpc-usage-scan.json"
: > "$w/rpc-started-rescan"; echo '{"credits": 30, "final": true}' > "$w/rpc-usage-rescan.json"
led bash "$here/rpc-ledger.sh" settle r1 "$w" >/dev/null && [[ $(lj 'l["used"], l["days"]["2026-09-20"], [o["id"] for o in l["outstanding"]]') == "(250, 150, ['r2'])" ]] &&
  ok "rpc-ledger: settle books the final spend of the scan and the rescan and closes the reservation" || no "rpc-ledger settle: $(lj 'l')"
w="$L/w2"; mkdir -p "$w"; : > "$w/rpc-started-scan"; echo '{"credits": 7, "final": false}' > "$w/rpc-usage-scan.json"
led bash "$here/rpc-ledger.sh" settle r2 "$w" >/dev/null && [[ $(lj 'l["used"], l["days"]["2026-09-19"], l["outstanding"]') == "(350, 100, [])" ]] &&
  ok "rpc-ledger: a spend without a final usage file (a killed run) books the whole reservation, never the last count written" || no "rpc-ledger kill: $(lj 'l')"
led bash "$here/rpc-ledger.sh" reserve r4 2026-09-18 900 50 "$L/r4" >/dev/null; w="$L/w4"; mkdir -p "$w"; : > "$w/rpc-started-scan"
led bash "$here/rpc-ledger.sh" settle r4 "$w" >/dev/null && [[ $(lj 'l["used"]') == 400 ]] && ok "rpc-ledger: a spend that started with no usage file books the whole reservation" || no "rpc-ledger no usage: $(lj 'l')"
led bash "$here/rpc-ledger.sh" reserve r5 2026-09-18 900 50 "$L/r5" >/dev/null; w="$L/w5"; mkdir -p "$w"
led bash "$here/rpc-ledger.sh" settle r5 "$w" >/dev/null && [[ $(lj 'l["used"]') == 400 ]] && ok "rpc-ledger: a run that never started spending books nothing" || no "rpc-ledger no start: $(lj 'l')"
# A run killed before settle leaves its reservation outstanding: the next reservation sees it.
led bash "$here/rpc-ledger.sh" reserve r6 2026-09-17 900 250 "$L/r6" >/dev/null
rc=0; led bash "$here/rpc-ledger.sh" reserve r7 2026-09-16 900 150 "$L/r7" >/dev/null || rc=$?
[[ $(cat "$L/r6") == 250 && $(cat "$L/r7") == 50 ]] && ok "rpc-ledger: an unsettled reservation (a lost runner) stays booked against the month" || no "rpc-ledger outstanding: $(cat "$L/r6" "$L/r7")"
before=$(cat "$T/rel/helius-ledger/ledger.json"); echo held > "$T/rel/helius-ledger/ledger.lock"
rc=0; led bash "$here/rpc-ledger.sh" settle r6 "$L/w5" 2>"$L/err" || rc=$?
rcR=0; led bash "$here/rpc-ledger.sh" reserve r8 2026-09-15 900 1 "$L/r8" 2>/dev/null || rcR=$?
[[ $rc == 1 && $rcR == 1 && ! -e "$L/r8" && "$(cat "$T/rel/helius-ledger/ledger.json")" == "$before" && -e "$T/rel/helius-ledger/ledger.lock" ]] && grep -q "stayed locked" "$L/err" &&
  ok "rpc-ledger: while another job holds the lock, a writer fails closed and changes nothing" || no "rpc-ledger lock: rc=$rc $(cat "$L/err")"
bash "$here/rpc-ledger.sh" unlock >/dev/null && [[ ! -e "$T/rel/helius-ledger/ledger.lock" ]] && led bash "$here/rpc-ledger.sh" settle r6 "$L/w5" >/dev/null &&
  [[ ! -e "$T/rel/helius-ledger/ledger.lock" ]] && ok "rpc-ledger: unlock clears a stale lock; a writer releases its own lock" || no "rpc-ledger unlock"
# A write that fails half-way never loses the ledger or a reservation (gh's --clobber
# deletes ledger.json before it uploads), and every failed write fails the command.
HL="$T/rel/helius-ledger"; lnx() { python3 -c 'import json,sys; l=json.load(open(sys.argv[1])); print(eval(sys.argv[2]))' "$HL/ledger.next.json" "$1"; }
rc=0; led FAKE_GH_CLOBBER_FAIL=1 GITHUB_STEP_SUMMARY="$L/sum" bash "$here/rpc-ledger.sh" reserve rB 2026-09-14 900 10 "$L/rB" >/dev/null 2>"$L/err" || rc=$?
[[ $rc == 1 && ! -e "$L/rB" && ! -e "$HL/ledger.json" && ! -e "$HL/ledger.lock" && $(lnx '[o["id"] for o in l["outstanding"]]') == "['r7', 'rB']" ]] &&
  grep -q '"rB"' "$L/sum" && grep -q "could not write the ledger" "$L/err" &&
  ok "rpc-ledger: reserve fails (no amount written) when replacing ledger.json fails after gh deleted it; ledger.next.json keeps every reservation, and the ledger goes to the step summary" || no "rpc-ledger clobber fail reserve: rc=$rc $(cat "$L/err")"
led bash "$here/rpc-ledger.sh" show | grep -q '"rB"' && ok "rpc-ledger: readers fall back to ledger.next.json" || no "rpc-ledger show next"
rc=0; led bash "$here/rpc-ledger.sh" init 2026-10 800000 700000 2>"$L/err" || rc=$?
[[ $rc == 1 && ! -e "$HL/ledger.json" && -e "$HL/ledger.next.json" ]] && grep -q "a ledger already exists (ledger.next.json" "$L/err" && ok "rpc-ledger: init refuses while only ledger.next.json exists" || no "rpc-ledger init next: rc=$rc"
mkdir -p "$L/wB"; led bash "$here/rpc-ledger.sh" settle rB "$L/wB" >/dev/null && [[ ! -e "$HL/ledger.next.json" && ! -e "$HL/ledger.lock" ]] &&
  [[ $(lj '[o["id"] for o in l["outstanding"]], [s["id"] for s in l["settled"]][-1]') == "(['r7'], 'rB')" ]] &&
  ok "rpc-ledger: the next writer carries ledger.next.json over and the release ends with one full ledger.json" || no "rpc-ledger next repair: $(ls "$HL") $(lj 'l')"
led bash "$here/rpc-ledger.sh" reserve rC 2026-09-14 900 10 "$L/rC" >/dev/null
rc=0; led FAKE_GH_CLOBBER_FAIL=1 bash "$here/rpc-ledger.sh" settle rC "$L/wB" >/dev/null 2>&1 || rc=$?
[[ $rc == 1 && ! -e "$HL/ledger.json" && $(lnx '[s["id"] for s in l["settled"]][-1], [o["id"] for o in l["outstanding"]]') == "('rC', ['r7'])" ]] &&
  ok "rpc-ledger: settle fails when replacing ledger.json fails; ledger.next.json holds the settlement" || no "rpc-ledger clobber fail settle: rc=$rc"
led bash "$here/rpc-ledger.sh" reserve rZ 2026-09-13 900 1 "$L/rZ" >/dev/null && led bash "$here/rpc-ledger.sh" settle rZ "$L/wB" >/dev/null && [[ -e "$HL/ledger.json" && ! -e "$HL/ledger.next.json" ]] || no "rpc-ledger repair after settle"
before=$(cat "$HL/ledger.json")
rc=0; led FAKE_GH_FAIL_ASSET=ledger.next.json bash "$here/rpc-ledger.sh" reserve rY 2026-09-13 900 1 "$L/rY" >/dev/null 2>&1 || rc=$?
[[ $rc == 1 && ! -e "$L/rY" && "$(cat "$HL/ledger.json")" == "$before" && ! -e "$HL/ledger.next.json" && ! -e "$HL/ledger.lock" ]] &&
  ok "rpc-ledger: a failed first upload fails reserve and leaves ledger.json as it was" || no "rpc-ledger next upload fail: rc=$rc"
rc=0; led FAKE_GH_DELETE_FAIL_ASSET=ledger.next.json bash "$here/rpc-ledger.sh" reserve rX 2026-09-13 900 1 "$L/rX" >/dev/null 2>&1 || rc=$?
[[ $rc == 1 && ! -e "$L/rX" && $(lj '[o["id"] for o in l["outstanding"]]') == "['r7', 'rX']" && $(lnx '[o["id"] for o in l["outstanding"]]') == "['r7', 'rX']" ]] &&
  led bash "$here/rpc-ledger.sh" settle rX "$L/wB" >/dev/null && [[ ! -e "$HL/ledger.next.json" ]] &&
  ok "rpc-ledger: a failed delete of ledger.next.json fails reserve (the reservation stays booked, not spent); the next writer clears it" || no "rpc-ledger next delete fail: rc=$rc"
echo "123 2026-01-01T00:00:00Z" > "$HL/ledger.lock"
rc=0; FAKE_GH_DOWNLOAD_FAIL=1 bash "$here/rpc-ledger.sh" unlock >/dev/null 2>"$L/err" || rc=$?
[[ $rc == 1 && -e "$HL/ledger.lock" ]] && grep -q "cannot read ledger.lock" "$L/err" &&
  ok "rpc-ledger: unlock fails closed when it cannot read the lock" || no "rpc-ledger unlock read error: rc=$rc $(cat "$L/err")"
echo "123 $(date -u +%FT%TZ)" > "$HL/ledger.lock"
rc=0; bash "$here/rpc-ledger.sh" unlock >/dev/null 2>"$L/err" || rc=$?
[[ $rc == 1 && -e "$HL/ledger.lock" ]] && grep -q "may still be writing" "$L/err" && echo "123 2026-01-01T00:00:00Z" > "$HL/ledger.lock" &&
  bash "$here/rpc-ledger.sh" unlock >/dev/null && [[ ! -e "$HL/ledger.lock" ]] &&
  ok "rpc-ledger: unlock refuses a lock younger than LOCK_WAIT and removes an old one" || no "rpc-ledger unlock young: rc=$rc $(cat "$L/err")"
# End to end: a day read killed mid-unit is settled at its whole reservation (the old
# per-run total booked only the last count the scanner wrote).
o="$T/rdk"; rm -rf "$o"; rc=0; RD_CREDITS=$(cat "$L/r7") rd "$o" RPC_CREDITS=7 RPC_RC=137 || rc=$?
led bash "$here/rpc-ledger.sh" settle r7 "$o" >/dev/null && [[ $rc == 137 && $(lj '[s["actual"] for s in l["settled"] if s["id"] == "r7"]') == "[50]" ]] &&
  ok "rpc-day + rpc-ledger: a read killed mid-unit (usage not final) is settled at its whole reservation" || no "rpc-day kill settle: rc=$rc $(lj 'l["settled"]')"
unset GH_BIN

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

# ---- archive-check.sh: one request with the scanner's agent; dispatch only on success, never while a scan runs ----
A="$T/ac"; mkdir -p "$A/bin"
cat > "$A/bin/gh" <<'SH'
#!/usr/bin/env bash
echo "gh $*" >> "$AC/gh.log"
case "$1 $2" in
  "run list") echo "${AC_ACTIVE:-0}" ;;
  "api repos/"*) day=${2##*data-day-}; grep -qx "$day" "$AC/published" 2>/dev/null ;;
  "workflow run") echo "$*" >> "$AC/dispatch.log" ;;
esac
SH
cat > "$A/bin/curl" <<'SH'
#!/usr/bin/env bash
printf '%s\n' "$@" > "$AC/curl.args"; echo x >> "$AC/curl.calls"
hdr=; while (( $# )); do [[ $1 == -D ]] && hdr=$2; shift; done
[[ "$AC_STATUS" == 000 ]] && exit 7
printf 'HTTP/2 %s\r\ncf-ray: 8abc123-SYD\r\n\r\n' "$AC_STATUS" > "$hdr"
head -c "${AC_BYTES:-64}" /dev/zero
exit "${AC_EXIT:-0}"
SH
chmod +x "$A/bin/"*
ac() { rm -f "$A"/*.log "$A/curl.calls" "$A/curl.args"; : > "$A/summary.md"
  AC="$A" GH_BIN="$A/bin/gh" CURL_BIN="$A/bin/curl" GH_REPO=o/r REF=main GITHUB_STEP_SUMMARY="$A/summary.md" "$@" bash "$here/archive-check.sh" > "$A/out.txt" 2>&1; }
ua=$(sed -n 's/^const userAgent = "\(.*\)"$/\1/p' "$here/../scanner/archive.go")
ac env AC_ACTIVE=1 AC_STATUS=206
[[ ! -e "$A/curl.calls" && ! -e "$A/dispatch.log" ]] && grep -q "active or queued" "$A/summary.md" &&
  ok "archive-check: a scan run active or queued means no request and no dispatch" || no "archive-check active no-op"
ac env AC_STATUS=429
[[ $(wc -l < "$A/curl.calls") == 1 && ! -e "$A/dispatch.log" ]] && grep -qx -- "-A" "$A/curl.args" && grep -qxF -- "$ua" "$A/curl.args" &&
  grep -qx -- "0-63" "$A/curl.args" && grep -q "| 429 | 64 | 0 | 8abc123-SYD |" "$A/summary.md" && [[ -n "$ua" ]] &&
  ok "archive-check: a 429 makes exactly one 64-byte request with the scanner's agent, logs status and cf-ray, dispatches nothing" || no "archive-check 429"
printf '2026-09-21\n2026-09-19\n' > "$A/published"
ac env AC_STATUS=206
[[ $(wc -l < "$A/curl.calls") == 1 && $(wc -l < "$A/dispatch.log") == 1 ]] &&
  grep -q -- "data-scan.yml --repo o/r --ref main -f mode=scan -f days=2026-09-20,2026-09-18,2026-09-17,2026-09-16,2026-09-15,2026-09-14,2026-09-13,2026-09-12 -f max_mbps=80" "$A/dispatch.log" &&
  ok "archive-check: a 206 dispatches once, the next 8 unpublished pre-holdout days at 80 MB/s" || no "archive-check 206 dispatch: $(cat "$A/dispatch.log" 2>/dev/null)"
d=2026-09-21; : > "$A/published"; while [[ "$d" > 2026-07-19 ]]; do echo "$d" >> "$A/published"; d=$(date -u -d "$d - 1 day" +%F); done
ac env AC_STATUS=206
grep -q -- "-f days=2026-10-01,2026-09-30,2026-09-29,2026-09-28,2026-09-27,2026-09-26,2026-09-25,2026-09-24 " "$A/dispatch.log" &&
  ok "archive-check: holdout days only after every pre-holdout day is published" || no "archive-check holdout order: $(cat "$A/dispatch.log" 2>/dev/null)"
ac env AC_STATUS=206 AC_BYTES=65
[[ ! -e "$A/dispatch.log" ]] && ok "archive-check: a 206 of more than 64 bytes is not served" || no "archive-check oversized 206"
ac env AC_STATUS=206 AC_EXIT=18
[[ ! -e "$A/dispatch.log" ]] && grep -q "| 206 | 64 | 18 |" "$A/summary.md" && ok "archive-check: a 206 whose transfer failed (curl exit kept across the pipe) is not served" || no "archive-check 206 with curl error: $(cat "$A/summary.md")"
ac env AC_STATUS=200
[[ ! -e "$A/dispatch.log" ]] && ok "archive-check: a 200 is not served, whatever its size" || no "archive-check 200"
ac env AC_STATUS=000
[[ $(wc -l < "$A/curl.calls") == 1 && ! -e "$A/dispatch.log" ]] && ok "archive-check: a network failure dispatches nothing" || no "archive-check failure"

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
port=$(cat "$A/port"); : > "$A/published"
t0=$(date +%s)
ac env -u CURL_BIN CURL_BIN=curl NO_PROXY=127.0.0.1 no_proxy=127.0.0.1 ARCHIVE_CHECK_URL="http://127.0.0.1:$port/stream"
t1=$(date +%s)
row=$(grep "^| 20" "$A/summary.md" | tail -1); IFS='|' read -r _ _ st by ex _ <<< "$row"
[[ ! -e "$A/dispatch.log" ]] && (( t1 - t0 < 10 )) && (( ${st// /} == 200 && ${by// /} <= 65 && ${ex// /} != 0 )) &&
  ok "archive-check: a server ignoring the range and streaming a chunked 200 is cut (${by// /} bytes, curl exit ${ex// /}) in $((t1 - t0)) s, nothing dispatched" || no "archive-check streaming: $row"
ac env -u CURL_BIN CURL_BIN=curl NO_PROXY=127.0.0.1 no_proxy=127.0.0.1 ARCHIVE_CHECK_URL="http://127.0.0.1:$port/ok"
[[ $(wc -l < "$A/dispatch.log" 2>/dev/null) == 1 ]] && grep -q "| 206 | 64 | 0 | ok-1 |" "$A/summary.md" &&
  ok "archive-check: a real 206 of 64 bytes dispatches once" || no "archive-check real 206: $(cat "$A/summary.md")"
kill $srv 2>/dev/null; wait $srv 2>/dev/null

python3 - "$here/../../../.github/workflows/archive-check.yml" <<'PY' && ok "archive-check workflow: every 3 hours plus dispatch, one job of one script step, token only there, no inputs in the shell, credentials not persisted" || no "archive-check workflow structure"
import sys, yaml
wf = yaml.safe_load(open(sys.argv[1]))
on = wf[True]
assert set(on) == {"schedule", "workflow_dispatch"} and on["schedule"] == [{"cron": "41 */3 * * *"}], on
assert wf["permissions"] == {"contents": "read", "actions": "write"}, wf["permissions"]
steps = wf["jobs"]["check"]["steps"]
assert len(steps) == 2 and steps[0]["with"]["persist-credentials"] is False, steps
assert steps[1]["run"] == "research/historical/ci/archive-check.sh" and "github.token" in steps[1]["env"]["GH_TOKEN"], steps[1]
assert all("${{" not in st.get("run", "") for st in steps)
assert not any(k in str(steps) for k in ("ARCHIVE_CHECK_URL", "CURL_BIN", "GH_BIN")), "test-only overrides in the workflow"
PY

python3 - "$here/../../../.github/workflows/data-scan.yml" <<'PY' && ok "data-scan source helius: refused without a cap of 1 to 1000000 or outside scan mode; the key only in the scan and QA steps and only for helius; credits reserved in the ledger before the scan and settled after QA, even on failure; own progress cache; the chain carries source and cap" || no "data-scan helius wiring"
import sys, yaml
wf = yaml.safe_load(open(sys.argv[1]))
ins = wf[True]["workflow_dispatch"]["inputs"]
assert ins["source"]["options"] == ["archive", "helius"] and ins["source"]["default"] == "archive", ins["source"]
plan = wf["jobs"]["plan"]["steps"][0]["run"]
assert 'source helius needs max_credits from 1 to 1000000' in plan and 'source helius is for mode scan only' in plan
steps = wf["jobs"]["scan"]["steps"]
key = [s for s in steps if "HELIUS_API_KEY" in str(s)]
assert [s.get("id") for s in key] == ["scan", "qa"], [s.get("name") for s in key]
for s in key:
    assert s["env"]["HELIUS_API_KEY"] == "${{ inputs.source == 'helius' && secrets.HELIUS_API_KEY || '' }}", s["env"]
assert "rpc-day.sh" in steps[[s.get("id") for s in steps].index("scan")]["run"]
caches = [s for s in steps if "actions/cache" in s.get("uses", "") and "work/data" in s["with"]["path"]]
assert caches and all(s["with"]["key"].startswith("${{ inputs.source == 'helius' && 'data-rpc' || 'data-scan' }}-") for s in caches), caches
r = wf["jobs"]["continue"]["steps"][0]["run"]
assert '-f source="$SOURCE" -f max_credits="$MAX_CREDITS" -f rpc_rps="$RPC_RPS"' in r, r
assert 'rpc_rps must be from 1 to 50' in plan and ins["rpc_rps"]["default"] == "5"
for s in key:
    assert s["env"]["RPC_RPS"] == "${{ inputs.rpc_rps }}", s["env"]
assert "secrets." not in str(wf["jobs"]["continue"]) and "secrets." not in str(wf["jobs"]["plan"])
# DATA-4: reserve before the scan (no key), spend only the reservation, settle after QA
ids = [s.get("id") or s.get("name") for s in steps]
assert ids.index("reserve") < ids.index("scan") < ids.index("qa") < ids.index("Settle Helius credits"), ids
res, stl = steps[ids.index("reserve")], steps[ids.index("Settle Helius credits")]
assert res["if"] == "inputs.source == 'helius' && steps.published.outputs.complete != 'true'", res["if"]
assert 'reserve "$RID" "$DAY" "$MAX_CREDITS" "$MAX_CREDITS" "$RUNNER_TEMP/rpc-reservation"' in res["run"], res["run"]
assert res["run"].index("rm -f") < res["run"].index("rpc-ledger.sh"), "old spend markers are cleared before reserving"
assert "always()" in stl["if"] and "steps.reserve.outcome != 'skipped'" in stl["if"] and 'settle "$RID" "$RUNNER_TEMP/work/data"' in stl["run"], stl
assert 'GITHUB_STEP_SUMMARY="$GITHUB_STEP_SUMMARY"' in res["run"] and 'GITHUB_STEP_SUMMARY="$GITHUB_STEP_SUMMARY"' in stl["run"], (res, stl)
assert res["env"]["RID"] == stl["env"]["RID"] == "${{ github.run_id }}-${{ github.run_attempt }}-${{ matrix.day }}"
assert 'rpc-day.sh "$DAY" "$RUNNER_TEMP/work/data" 300 "$(cat "$RUNNER_TEMP/rpc-reservation")"' in steps[ids.index("scan")]["run"]
assert 'RPC_RESERVATION=$(cat "$RUNNER_TEMP/rpc-reservation")' in steps[ids.index("qa")]["run"]
assert "max_credits" not in str(steps[ids.index("scan")]["env"]) and "max_credits" not in str(steps[ids.index("qa")]["env"]), "the scan and QA spend the reservation, not the input"
PY

# The plan job's own validation, run as written in data-scan.yml.
python3 - "$here/../../../.github/workflows/data-scan.yml" > "$T/plan.py" <<'PY'
import sys, yaml
run = yaml.safe_load(open(sys.argv[1]))["jobs"]["plan"]["steps"][0]["run"]
print(run.split("<<'EOF' >> \"$GITHUB_OUTPUT\"\n", 1)[1].rsplit("\nEOF", 1)[0])
PY
plan() { env MODE=scan DAYS=2026-09-21 MAX_MBPS=80 SOURCE=helius MAX_CREDITS=260000 RPC_RPS=5 REGIME_BOUNDARY_DAY=2026-10-02 "$@" python3 "$T/plan.py" > "$T/plan.out" 2>&1; }
bad=""
plan || bad+=" valid-refused"
for v in 0 51 5.5 ""; do plan RPC_RPS="$v" && bad+=" rps=$v"; done
for v in 0 1000001 ""; do plan MAX_CREDITS="$v" && bad+=" credits=$v"; done
plan MODE=volume && bad+=" helius-volume"
plan SOURCE=other && bad+=" source=other"
plan SOURCE=archive MAX_CREDITS=0 RPC_RPS=0 || bad+=" archive-refused"
[[ -z "$bad" ]] && ok "data-scan plan: refuses rpc_rps 0, 51, 5.5 and empty, a cap outside 1..1000000, helius outside scan, an unknown source; accepts the free day and archive scans" || no "data-scan plan validation:$bad"

echo "$pass passed, $fail failed"
(( fail == 0 ))
