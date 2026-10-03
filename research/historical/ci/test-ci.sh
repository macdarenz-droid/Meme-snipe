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
  (cd "$dir" && sha256sum units-"$day".tar.part* > "SHA256SUMS-$day")
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
grep -q -- "-lead-in-days 14" "$T/finalize.args" && grep -q -- "-part-mb 1900" "$T/finalize.args" &&
  ! grep -q -- "-allow-revisions" "$T/finalize.args" && ok "finalize gets -part-mb 1900 -lead-in-days 14, no -allow-revisions" || no "finalize args: $(cat "$T/finalize.args")"
grep -q -- "--live 60 --strict" "$T/check.args" && ok "strict QA with --live 60" || no "check args"
R="$T/rel/data-2026-09-20-2026-09-22"
[[ -e "$R/2026-09-20__curve_trades-0000.csv.zst" && -e "$R/manifest.json" && -e "$R/mints-0000.csv.zst" && -e "$R/qa-report.md" && -e "$R/qa-report.json" && -e "$R/parity.json" ]] &&
  (cd "$R" && sha256sum -c --quiet SHA256SUMS) && ok "release data-FROM-TO holds flat day files, manifest, mints, QA, parity, valid SHA256SUMS" || no "release contents: $(ls "$R" 2>&1)"
[[ ! -e "$T/work/dataset/manifest.json" ]] && ok "release files were moved, not copied" || no "dataset files still present"

# ---- 2. refusals ----
run 2026-09-01 2026-09-12 "$T/w2" && no "11-day window accepted" || { grep -q "limit is 10" "$T/out.txt" && ok "window over 10 days refused" || no "window message: $(cat "$T/out.txt")"; }
MAX_WINDOW_DAYS=3 run 2026-09-20 2026-09-24 "$T/w2" && no "MAX_WINDOW_DAYS ignored" || ok "MAX_WINDOW_DAYS is honoured"
run 2026-09-22 2026-09-20 "$T/w2" && no "reversed window accepted" || ok "reversed window refused"
run 2026-09-20 2026-09-22 "$T/w3" && no "existing dataset release replaced" || { grep -q "already exists" "$T/out.txt" && ok "existing dataset release refused" || no "existing release message"; }

reset_store; rm -rf "$T/rel/data-day-2026-09-10"
run 2026-09-20 2026-09-22 "$T/work" && no "missing lead-in day skipped silently" ||
  { grep -q "data-day-2026-09-10 is missing" "$T/out.txt" && [[ ! -s "$T/downloads.log" ]] && ok "missing lead-in day fails before any download" || no "missing day: $(cat "$T/out.txt")"; }

reset_store
FAKE_AVAIL=1000 run 2026-09-20 2026-09-22 "$T/work" && no "disk guard passed" || { grep -q "not enough disk" "$T/out.txt" && ok "free-space guard (3x tar + 10 GB)" || no "disk guard message"; }

reset_store; echo junk >> "$T/rel/data-day-2026-09-08/units-2026-09-08.tar.part00"
run 2026-09-20 2026-09-22 "$T/work" && no "corrupt part accepted" || { grep -q "checksum mismatch" "$T/out.txt" && ok "corrupt part fails the checksum" || no "checksum message: $(cat "$T/out.txt")"; }

STATS_REV_2026_09_20=r2 reset_store
run 2026-09-20 2026-09-22 "$T/work" && no "midnight unit with another scanner_revision accepted" ||
  { grep -q "differs between days: stats.json differs in scanner_revision" "$T/out.txt" && ok "midnight unit with a different scanner_revision fails" || no "revision message: $(cat "$T/out.txt")"; }

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
[[ $rc == 75 && ! -s "$T/calls.log" ]] && ok "a back-off that does not fit the budget exits 75 without scanning" || no "budget exit: rc=$rc $(calls)"
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
  for f in units-2026-09-30.tar.part00 units-2026-09-30.tar.part01 qa-2026-09-30.md qa-2026-09-30.json manifest-2026-09-30.json parity-2026-09-30.json; do echo "$f" > "$pd/$f"; done
  (cd "$pd" && sha256sum units-* qa-* manifest-* parity-* > SHA256SUMS-2026-09-30)
}
mkpd
bash "$here/publish-day.sh" 2026-09-30 "$pd" >/dev/null && [[ $(ls "$T/rel/data-day-2026-09-30" | wc -l) == 7 ]] &&
  ok "publish-day: release data-day-DAY created with parts, QA, manifest, parity and sums" || no "publish-day create"
echo "rerun QA report with different live results" > "$pd/qa-2026-09-30.md"; echo '{"rerun":1}' > "$pd/qa-2026-09-30.json"
(cd "$pd" && sha256sum units-* qa-* manifest-* parity-* > SHA256SUMS-2026-09-30)
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
rm -rf "$T/rel/data-day-2026-09-30"; mkpd; echo corrupt >> "$pd/units-2026-09-30.tar.part00"
bash "$here/publish-day.sh" 2026-09-30 "$pd" >/dev/null 2>&1 && no "publish-day published a corrupt part" ||
  { [[ ! -d "$T/rel/data-day-2026-09-30" ]] && ok "publish-day: a checksum mismatch publishes nothing" || no "publish-day corrupt"; }
mkpd; rm "$pd/parity-2026-09-30.json"; (cd "$pd" && sha256sum units-* qa-* manifest-* > SHA256SUMS-2026-09-30)
bash "$here/publish-day.sh" 2026-09-30 "$pd" >/dev/null 2>&1 && no "publish-day published without parity" || ok "publish-day: a missing parity report publishes nothing"
mkpd; (cd "$pd" && sha256sum units-* qa-* manifest-* > SHA256SUMS-2026-09-30)
out=$(bash "$here/publish-day.sh" 2026-09-30 "$pd" 2>&1) && no "publish-day published a file missing from SHA256SUMS" ||
  { [[ "$out" == *"not listed"* && ! -d "$T/rel/data-day-2026-09-30" ]] && ok "publish-day: a file not listed in SHA256SUMS publishes nothing" || no "publish-day unlisted: $out"; }
printf '#!/usr/bin/env bash\necho "$*" >> "%s/ghcalls.log"\n' "$T" > "$T/ghrec"; chmod +x "$T/ghrec"; : > "$T/ghcalls.log"
out=$(GH_BIN="$T/ghrec" bash "$here/publish-day.sh" 2026-10-02 "$pd" 2>&1) && no "publish-day published the regime-boundary day" ||
  { [[ "$out" == *"regime boundary"* && ! -s "$T/ghcalls.log" ]] && ok "publish-day: 2026-10-02 and later refused before any gh call" || no "publish-day boundary: $out"; }
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
python3 - "$here/../../../.github/workflows/data-scan.yml" <<'PY' && ok "workflow: every step after the published check (scan, QA, publish) is skipped for a complete day; token only in the check and publish steps, both in a clean shell" || no "workflow skip/token structure"
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
assert [s.get("id") or s.get("name") for s in tok] == ["published", "Publish this day"], tok
for s in tok:
    assert s["shell"].startswith("/usr/bin/env -u BASH_ENV -u ENV /usr/bin/bash --noprofile --norc"), s
    assert s["env"]["BASH_ENV"] == "" and s["run"].startswith("/usr/bin/env -i PATH=/usr/bin:/bin "), s
PY

echo "$pass passed, $fail failed"
(( fail == 0 ))
