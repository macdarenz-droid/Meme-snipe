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
python3 - "$here/../../../.github/workflows/data-scan.yml" <<'PY' && ok "workflow: every step after the published check (scan, QA, publish) is skipped for a complete day; token only in the check and publish steps, both in a clean shell; a resumable stop chains the next run, bounded, only after a saved progress; QA starts only with 45 min left" || no "workflow skip/token structure"
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
assert [s.get("id") or s.get("name") for s in tok] == ["published", "Publish this day", "Publish this day's volume hours"], tok
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
assert "zeroed-scan pilot" in r and '-max-credits "$MAX_CREDITS"' in r and "-sample 0.05" in r and "HELIUS_API_KEY" not in r, r
up = [st for st in steps if "upload-artifact" in st.get("uses", "")]
assert len(up) == 1 and up[0]["with"]["path"].endswith("/report/pilot-report.json"), up
assert "github.token" not in open(sys.argv[1]).read()
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

echo "$pass passed, $fail failed"
(( fail == 0 ))
