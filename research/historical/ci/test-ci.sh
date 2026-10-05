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
echo scan >> "$T/calls.log"; echo "$*" > "$T/scan.args"
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
# A scanner capped at 10 requests/s (archive-limits.conf); variants for the refusals.
for n in 10 40 10.5; do sed "s/^var reqLimiter = newLimiter([0-9.]*)\$/var reqLimiter = newLimiter($n)/" "$here/../scanner/archive.go" > "$T/archive$n.go"; done
grep -v '^var reqLimiter' "$here/../scanner/archive.go" > "$T/archivenone.go"
grep -qx 'var reqLimiter = newLimiter(10)' "$T/archive10.go" || no "test copy of archive.go at 10/s"
scan() {
  : > "$T/calls.log"
  ARCHIVE_GO=${ARCHIVE_GO:-$T/archive10.go} PATH="$S:$PATH" GITHUB_STEP_SUMMARY="$T/summary.md" bash "$here/scan-day.sh" 2026-09-20 "$1" "${MBPS:-40}" "${2:-300}" > "$T/out.txt" 2>&1
}
calls() { tr '\n' ' ' < "$T/calls.log"; }
o="$T/scan1"; mkdir -p "$o"; now=$(date +%s); echo "$((now - 5)) 600 $((now + 120))" > "$o/archive-429.state"
if scan "$o"; then
  mapfile -t c < "$T/calls.log"; w=${c[0]#sleep }
  [[ ${#c[@]} == 2 && "${c[0]}" == sleep* && "${c[1]}" == scan ]] && (( w >= 110 && w <= 120 )) &&
    ok "scan-day honours an existing back-off: waits until its end (${w} s) before the first scan" || no "existing back-off: $(calls)"
else no "scan-day with an existing back-off: $(cat "$T/out.txt")"; fi
o="$T/scan2"; mkdir -p "$o"; : > "$T/summary.md"
rc=0; t0=$(date +%s); FIRST_RC=75 scan "$o" || rc=$?
end=$(awk '{print $3}' "$o/archive-429.state")
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
ARCHIVE_GO="$T/archive10.go" SCANNER_REVISION=rNew PATH="$S:$PATH" GITHUB_STEP_SUMMARY="$T/summary.md" bash "$here/scan-day.sh" 2026-09-20 "$o" 40 300 > "$T/out.txt" 2>&1
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
assert [s.get("id") or s.get("name") for s in tok] == ["published", "pickprogress", "Publish this day", "Publish this day's volume hours"], tok
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
assert c["permissions"] == {"actions": "write"} and int(c["env"]["MAX_CHAIN"]) <= 12, c
assert len(c["steps"]) == 1 and "uses" not in c["steps"][0], c
r = c["steps"][0]["run"]
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
  : > "$T/zs.args"
  ARCHIVE_GO=${ARCHIVE_GO:-$T/archive10.go} RESCAN_RC=$2 FAKE_AVAIL=999000000000 DATASET_PARENT="$T/cd-ds" PATH="$C:$PATH" GITHUB_STEP_SUMMARY="$T/summary.md" \
    bash "$here/check-day.sh" 2026-09-20 "$o" "$T/cd-assets-$1" > "$T/out.txt" 2>&1
}
rc=0; t0=$(date +%s); cdrun a 75 || rc=$?
end=$(awk '{print $3}' "$T/cd-a/archive-429.state" 2>/dev/null)
[[ $rc == 4 ]] && (( ${end:-0} >= t0 + 10800 )) && grep -q "429 during the determinism rescan: back-off of at least 3 h; the chain stops" "$T/summary.md" &&
  ok "ARCHIVE-SAFE: check-day: a 429 in the determinism rescan holds a 3 h back-off and exits 4 (not resumable)" || no "check-day 429: rc=$rc end=$end $(cat "$T/out.txt")"
for p in finalize qa parity volume determinism; do grep -q "^phase $p (2026-09-20): [0-9]* s$" "$T/summary.md" || { no "check-day: no duration for $p"; break; }; done
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
[[ -n "${RPC_SLEEP:-}" ]] && { sleep "$RPC_SLEEP" & wait $!; }
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

# ---- archive-check.sh: one request with the scanner's agent; dispatch only on success, never while a scan runs ----
A="$T/ac"; mkdir -p "$A/bin"
cat > "$A/bin/gh" <<'SH'
#!/usr/bin/env bash
echo "gh $*" >> "$AC/gh.log"
jqx=; for ((i = 1; i <= $#; i++)); do [[ "${!i}" == --jq ]] && { j=$((i + 1)); jqx=${!j}; }; done
case "$1 $2" in
  "run list") printf '%s' "${AC_RUNS:-[]}" | jq -r "$jqx" ;;
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
# Active runs by title (data-scan.yml's run-name): helius-only, archive, a run from before
# run-name ("data-scan"), the volume mode, anything unexpected.
runs() { python3 -c 'import json,sys; print(json.dumps([{"databaseId": 100 + i, "status": a.split("|")[0], "displayTitle": a.split("|")[1]} for i, a in enumerate(sys.argv[1:])]))' "$@"; }
H="in_progress|data-scan scan source=helius"
bad=""
for set in "in_progress|data-scan scan source=archive" "queued|data-scan scan source=archive" "in_progress|data-scan" "queued|data-scan volume source=archive" \
           "in_progress|data-scan scan source=helius2" "in_progress|data-scan scan source=helius " "$H;in_progress|data-scan" "$H;queued|data-scan scan source=archive"; do
  IFS=';' read -ra a <<< "$set"
  ac env AC_RUNS="$(runs "${a[@]}" "completed|data-scan scan source=archive")" AC_STATUS=206
  [[ ! -e "$A/curl.calls" && ! -e "$A/dispatch.log" ]] && grep -q "may read the archive active or queued; no request made" "$A/summary.md" || bad+=" [$set]"
done
[[ -z "$bad" ]] && ok "archive-check: a run that may read the archive (archive source, no source in its title, anything unexpected) means no request and no dispatch" || no "archive-check archive-run no-op:$bad"
bad=""
sed 's/^var reqLimiter = newLimiter([0-9.]*)$/var reqLimiter = newLimiter(10)/' "$here/../scanner/archive.go" > "$A/lane10.go"
for set in "$H" "queued|data-scan scan source=helius" "$H;queued|data-scan scan source=helius"; do
  IFS=';' read -ra a <<< "$set"
  ac env AC_RUNS="$(runs "${a[@]}" "completed|data-scan scan source=archive")" AC_STATUS=206 ARCHIVE_GO="$A/lane10.go"
  [[ $(wc -l < "$A/curl.calls" 2>/dev/null) == 1 && $(wc -l < "$A/dispatch.log" 2>/dev/null) == 1 ]] && grep -q "served; dispatched data-scan for" "$A/summary.md" || bad+=" [$set]"
  grep -q 'gh run list --repo o/r --workflow data-scan.yml --limit 50 --json databaseId,status,displayTitle' "$A/gh.log" || bad+=" [list-call]"
done
ac env AC_RUNS="$(runs "$H")" AC_STATUS=429
[[ $(wc -l < "$A/curl.calls") == 1 && ! -e "$A/dispatch.log" ]] && grep -q "not served" "$A/summary.md" || bad+=" [429]"
# helius_runs (manual dispatch): an old-title run named by id counts as Helius-only (ids
# are 100, 101, ... in list order).
ac env AC_RUNS="$(runs "in_progress|data-scan" "in_progress|data-scan")" AC_STATUS=206 HELIUS_RUNS=100,101 ARCHIVE_GO="$A/lane10.go"
[[ $(wc -l < "$A/curl.calls" 2>/dev/null) == 1 && $(wc -l < "$A/dispatch.log" 2>/dev/null) == 1 ]] || bad+=" [named]"
# The ARCHIVE-SAFE hold still applies beside a Helius run: a scanner capped above 10/s
# (today's scanner/archive.go) dispatches nothing.
ac env AC_RUNS="$(runs "$H")" AC_STATUS=206
[[ $(wc -l < "$A/curl.calls" 2>/dev/null) == 1 && ! -e "$A/dispatch.log" ]] && grep -q "held:" "$A/summary.md" || bad+=" [hold-beside-helius]"
ac env AC_RUNS="$(runs "in_progress|data-scan" "queued|data-scan scan source=archive")" AC_STATUS=206 HELIUS_RUNS=100
[[ ! -e "$A/curl.calls" && ! -e "$A/dispatch.log" ]] && grep -q "may read the archive active or queued; no request made" "$A/summary.md" || bad+=" [named-but-archive-active]"
ac env AC_RUNS="$(runs "in_progress|data-scan")" AC_STATUS=206 HELIUS_RUNS=999,1000
[[ ! -e "$A/curl.calls" ]] || bad+=" [other-id]"
ac env AC_RUNS="$(runs "in_progress|data-scan")" AC_STATUS=206 HELIUS_RUNS=10
[[ ! -e "$A/curl.calls" ]] || bad+=" [prefix-id]"
for v in "100;x" "100 101" "abc" "100," ",100" "1e3" '$(id)'; do
  rc=0; ac env AC_RUNS="$(runs "in_progress|data-scan")" AC_STATUS=206 HELIUS_RUNS="$v" || rc=$?
  [[ $rc == 1 && ! -e "$A/curl.calls" && ! -e "$A/gh.log" ]] && grep -q "helius_runs must be run ids" "$A/summary.md" || bad+=" [refuse:$v]"
done
[[ -z "$bad" ]] && ok "ARCHIVE-LANE: only Helius runs active or queued (title source=helius, or an id named in helius_runs; anything else refused or blocking): exactly one request, and a served answer dispatches the archive day beside them (the ARCHIVE-SAFE hold still applies)" || no "archive-check helius-only:$bad"
ac env AC_STATUS=429
[[ $(wc -l < "$A/curl.calls") == 1 && ! -e "$A/dispatch.log" ]] && grep -qx -- "-A" "$A/curl.args" && grep -qxF -- "$ua" "$A/curl.args" &&
  grep -qx -- "0-63" "$A/curl.args" && grep -q "| 429 | 64 | 0 | 8abc123-SYD |" "$A/summary.md" && [[ -n "$ua" ]] &&
  ok "archive-check: a 429 makes exactly one 64-byte request with the scanner's agent, logs status and cf-ray, dispatches nothing" || no "archive-check 429"
printf '2026-09-21\n2026-09-19\n' > "$A/published"
# ARCHIVE-SAFE hold: with the scanner's request cap above 10/s (today's 40), a served
# check dispatches nothing; a scanner capped at 10/s (a test copy) lets it dispatch.
ac env AC_STATUS=206
[[ $(wc -l < "$A/curl.calls") == 1 && ! -e "$A/dispatch.log" ]] && grep -q "held: the scanner's request cap (40/s, scanner/archive.go) is above 10/s" "$A/summary.md" &&
  ok "ARCHIVE-SAFE: served, but the scanner's request cap (40/s) is above 10/s: held, nothing dispatched" || no "archive-check hold: $(cat "$A/summary.md")"
sed 's/^var reqLimiter = newLimiter(40)$/var reqLimiter = newLimiter(10)/' "$here/../scanner/archive.go" > "$A/archive10.go"
sed 's/^var reqLimiter = newLimiter(40)$/var reqLimiter = newLimiter(10.5)/' "$here/../scanner/archive.go" > "$A/archive105.go"
grep -v '^var reqLimiter' "$here/../scanner/archive.go" > "$A/archivenone.go"
bad=""
for g in archive105 archivenone; do ac env AC_STATUS=206 ARCHIVE_GO="$A/$g.go"; [[ ! -e "$A/dispatch.log" ]] && grep -q "held:" "$A/summary.md" || bad+=" $g"; done
[[ -z "$bad" ]] && ok "ARCHIVE-SAFE: a cap of 10.5/s or no cap found is held too" || no "archive-check hold variants:$bad"
ac env AC_STATUS=206 ARCHIVE_GO="$A/archive10.go"
[[ $(wc -l < "$A/curl.calls") == 1 && $(wc -l < "$A/dispatch.log") == 1 ]] &&
  grep -q -- "data-scan.yml --repo o/r --ref main -f mode=scan -f days=2026-09-20 -f max_mbps=40$" "$A/dispatch.log" &&
  ok "ARCHIVE-SAFE: a 206 dispatches once, the next 1 unpublished pre-holdout day at 40 MB/s" || no "archive-check 206 dispatch: $(cat "$A/dispatch.log" 2>/dev/null)"
: > "$A/published"
ac env AC_STATUS=206 ARCHIVE_GO="$A/archive10.go"
grep -q -- "-f days=2026-09-20 -f max_mbps=40$" "$A/dispatch.log" &&
  ok "ARCHIVE-NODUP: with nothing published the archive queue skips the Helius day 2026-09-21 and starts at 2026-09-20" || no "archive-check skips helius day: $(cat "$A/dispatch.log" 2>/dev/null)"
d=2026-09-20; : > "$A/published"; while [[ "$d" > 2026-07-19 ]]; do echo "$d" >> "$A/published"; d=$(date -u -d "$d - 1 day" +%F); done
for d in 2026-10-01 2026-09-30 2026-09-29 2026-09-28 2026-09-27 2026-09-26 2026-09-25 2026-09-24 2026-09-23 2026-09-22; do echo "$d" >> "$A/published"; done
ac env AC_STATUS=206 ARCHIVE_GO="$A/archive10.go"
[[ ! -e "$A/dispatch.log" ]] && grep -q "every day of the window is published" "$A/summary.md" &&
  ok "ARCHIVE-NODUP: with every other day published, the unpublished Helius day is never queued for the archive" || no "archive-check helius day last: $(cat "$A/dispatch.log" 2>/dev/null)"
d=2026-09-21; : > "$A/published"; while [[ "$d" > 2026-07-19 ]]; do echo "$d" >> "$A/published"; d=$(date -u -d "$d - 1 day" +%F); done
ac env AC_STATUS=206 ARCHIVE_GO="$A/archive10.go"
grep -q -- "-f days=2026-10-01 " "$A/dispatch.log" &&
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
ac env -u CURL_BIN CURL_BIN=curl NO_PROXY=127.0.0.1 no_proxy=127.0.0.1 ARCHIVE_CHECK_URL="http://127.0.0.1:$port/ok" ARCHIVE_GO="$A/archive10.go"
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
assert not any(k in str(steps) for k in ("ARCHIVE_CHECK_URL", "CURL_BIN", "GH_BIN", "ARCHIVE_GO")), "test-only overrides in the workflow"
assert set(on["workflow_dispatch"]["inputs"]) == {"helius_runs"} and on["workflow_dispatch"]["inputs"]["helius_runs"]["default"] == "", on
assert steps[1]["env"]["HELIUS_RUNS"] == "${{ github.event_name == 'workflow_dispatch' && inputs.helius_runs || '' }}", steps[1]["env"]
PY

python3 - "$here/../../../.github/workflows/data-scan.yml" <<'PY' && ok "data-scan source helius: refused without a cap of 1 to 1000000 or outside scan mode; the key only in the scan and QA steps and only for helius; own progress cache; the chain carries source and cap" || no "data-scan helius wiring"
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
saves = [s for s in caches if "cache/save" in s["uses"]]
assert saves and all(s["with"]["key"].startswith("${{ inputs.source == 'helius' && 'data-rpc' || 'data-scan' }}-") for s in saves), saves
res = next(s for s in caches if "cache/restore" in s["uses"])
assert res["with"]["key"] == "${{ steps.pickprogress.outputs.key || format('{0}-{1}-{2}', inputs.source == 'helius' && 'data-rpc' || 'data-scan', matrix.day, github.run_id) }}" and "restore-keys" not in res["with"], res
pick = next(s for s in steps if s.get("id") == "pickprogress")
assert pick["env"]["PREFIX"] == "${{ inputs.source == 'helius' && 'data-rpc' || 'data-scan' }}-${{ matrix.day }}-", pick
r = wf["jobs"]["continue"]["steps"][0]["run"]
assert '-f source="$SOURCE" -f max_credits="$MAX_CREDITS" -f rpc_rps="$RPC_RPS"' in r, r
assert 'rpc_rps must be from 1 to 50' in plan and ins["rpc_rps"]["default"] == "5"
for s in key:
    assert s["env"]["RPC_RPS"] == "${{ inputs.rpc_rps }}", s["env"]
assert "secrets." not in str(wf["jobs"]["continue"]) and "secrets." not in str(wf["jobs"]["plan"])
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
[[ $rc == 75 && $rc2 == 1 && $msg == 1 && $(cat "$o/rpc-credits-used") == 5 ]] &&
  ok "HISTORY-RESUME: rpc-day turns a truncated RPC response (rpcscan exit 1, 'rpc response: unexpected end of JSON input') into exit 75 with credits booked; other exit-1 errors stay fatal" || no "rpc-day transient: rc=$rc rc2=$rc2"
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
pp() { : > "$PP/out"; PPD="$PP" GH_BIN="$PP/bin/gh" GITHUB_REPOSITORY=o/r GITHUB_REF=refs/heads/ccr-x GITHUB_OUTPUT="$PP/out" GITHUB_STEP_SUMMARY="$PP/sum" bash "$here/progress-pick.sh" "$@"; }
python3 - "$PP/caches.json" <<'PY'
import json, sys
c = lambda k, s, t, r="refs/heads/ccr-x": {"key": k, "size_in_bytes": s, "created_at": t, "ref": r}
json.dump({"actions_caches": [
  c("data-rpc-2026-09-21-37264343113-1", 4186871358, "2026-10-05T09:30:56Z"),
  c("data-rpc-2026-09-21-37290557627-1", 4186871400, "2026-10-05T09:47:50Z"),
  c("data-rpc-2026-09-21-37292410621-1", 1024, "2026-10-05T09:49:26Z"),
  c("data-rpc-2026-09-21-37312693149-1", 810661685, "2026-10-05T17:52:50Z"),
  c("data-rpc-2026-09-21-37290557627-1-qa", 9000000000, "2026-10-05T10:00:00Z"),
  c("data-rpc-2026-09-21-1-1", 9900000000, "2026-10-05T10:00:00Z", "refs/pull/7/merge"),
  c("data-rpc-2026-09-210-1-1", 9900000000, "2026-10-05T10:00:00Z")]}, open(sys.argv[1], "w"))
PY
pp data-rpc-2026-09-21- >/dev/null && grep -qx "key=data-rpc-2026-09-21-37290557627-1" "$PP/out" &&
  ok "HISTORY-RESUME: progress-pick resumes from the largest progress entry of the day (66 units), never the newest near-empty or 11-unit one; -qa copies, other refs and other days are ignored" || no "progress-pick: $(cat "$PP/out")"
echo '{"actions_caches": []}' > "$PP/caches.json"; pp data-rpc-2026-09-21- >/dev/null && grep -qx "key=" "$PP/out" && ok "HISTORY-RESUME: progress-pick with no saved progress picks nothing" || no "progress-pick empty"
bad=""; rc=0; PP_FAIL=1 pp data-rpc-2026-09-21- >/dev/null 2>&1 || rc=$?; [[ $rc != 0 ]] || bad+=" api"
rc=0; pp 'data-rpc-2026-09-21' >/dev/null 2>&1 || rc=$?; [[ $rc == 2 ]] || bad+=" prefix"
[[ -z "$bad" ]] && ok "HISTORY-RESUME: progress-pick fails on an API error (nothing is read) and on a bad prefix" || no "progress-pick failures:$bad"
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
assert job["permissions"] == {"contents": "write", "actions": "read"}, job["permissions"]
steps = job["steps"]
ids = [s.get("id") or s.get("name") for s in steps]
assert ids.index("pickprogress") < ids.index("restore") < ids.index("record") < ids.index("scan")
rec = steps[ids.index("record")]
assert rec["run"] == 'research/historical/ci/progress-guard.sh record "$RUNNER_TEMP/work/data"', rec
assert rec["env"] == {"EXPECT_UNITS": "${{ inputs.expect_units }}", "PICKED": "${{ steps.pickprogress.outputs.key }}"} and rec["id"] == "record", rec
assert wf[True]["workflow_dispatch"]["inputs"]["expect_units"]["default"] == "", "expect_units defaults to no check"
cont = wf["jobs"]["continue"]
assert '-f expect_units="$EXPECT_UNITS"' in cont["steps"][0]["run"] and cont["steps"][0]["env"]["EXPECT_UNITS"] == "${{ inputs.expect_units }}", "the chain carries expect_units"
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
keep = [s for s in steps if "actions/cache/save" in s.get("uses", "") and "work/assets" in s["with"]["path"]]
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
rv="$T/rpcvol"; rm -rf "$rv"; mkdir -p "$rv"; vrows > "$rv/volume-hours-2026-09-30.csv"; echo '{"mismatches": [], "problems": []}' > "$rv/volume-check-2026-09-30.json"
cp "$rp/manifest-$d.json" "$rv/manifest-2026-09-30.json"; rm -rf "$T/rel/data-volume-2026-09-30"
out=$(bash "$here/publish-volume.sh" 2026-09-30 "$rv" 2>&1) && no "publish-volume published a day read over RPC" ||
  { [[ "$out" == *"read over RPC"* && ! -e "$T/rel/data-volume-2026-09-30" && ! -s "$T/created.log" ]] && ok "publish-volume: a day whose manifest lists an RPC unit is refused before any gh call" || no "publish-volume rpc: $out"; }
rm -f "$rv/manifest-2026-09-30.json"
bash "$here/publish-volume.sh" 2026-09-30 "$rv" >/dev/null && [[ -e "$T/rel/data-volume-2026-09-30" ]] && ok "publish-volume: the same files without an RPC manifest still publish (control)" || no "publish-volume control"
unset GH_BIN

# The plan job's own validation, run as written in data-scan.yml.
python3 - "$here/../../../.github/workflows/data-scan.yml" > "$T/plan.py" <<'PY'
import sys, yaml
run = yaml.safe_load(open(sys.argv[1]))["jobs"]["plan"]["steps"][0]["run"]
print(run.split("<<'EOF' >> \"$GITHUB_OUTPUT\"\n", 1)[1].rsplit("\nEOF", 1)[0])
PY
( . "$here/archive-limits.conf"
  python3 - "$here/../../../.github/workflows/data-scan.yml" "$ARCHIVE_MAX_MBPS" "$ARCHIVE_MAX_RPS" "$ARCHIVE_PARALLEL" "$ARCHIVE_DL" "$ARCHIVE_BACKOFF_S" "$ARCHIVE_DAYS_PER_CHECK" <<'PY'
import sys, yaml
wf = yaml.safe_load(open(sys.argv[1]))
mbps, rps, par, dl, back, days = map(int, sys.argv[2:])
assert (mbps, rps, par, dl, back, days) == (40, 10, 1, 4, 10800, 1), (mbps, rps, par, dl, back, days)
assert wf[True]["workflow_dispatch"]["inputs"]["max_mbps"]["default"] == str(mbps)
assert f"if not 0 < mbps <= {mbps}:" in wf["jobs"]["plan"]["steps"][0]["run"]
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

echo "$pass passed, $fail failed"
(( fail == 0 ))
