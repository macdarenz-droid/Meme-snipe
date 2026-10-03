#!/usr/bin/env bash
# Offline tests for assemble.sh: gh, df, zeroed-scan and node are PATH stubs over a
# fake release store, so no network is used.   bash research/historical/ci/test-ci.sh
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
    (cd "$dir" && for f in *; do printf '{"name":"%s","size":%d}\n' "$f" "$(stat -c %s "$f")"; done) |
      jq -s '{assets: .}' | jq -r "$jqx" ;;
  download)
    [[ -d "$dir" ]] || exit 1
    echo "$tag" >> "$T/downloads.log"
    out="" pats=()
    while (( $# )); do
      case "$1" in --dir) out=$2; shift ;; --pattern) pats+=("$2"); shift ;; esac; shift
    done
    for p in "${pats[@]}"; do for f in "$dir"/$p; do [[ -e "$f" ]] && cp "$f" "$out/"; done; done ;;
  create) mkdir "$dir"; echo "$tag" >> "$T/created.log" ;;
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
    for f in events.jsonl.zst stats.json blocks.csv.zst curve_trades.csv.zst raw.jsonl.zst; do
      head -c 3000 /dev/zero | tr '\0' x > "$src/units/900/$u/$f"; echo "$u" >> "$src/units/900/$u/$f"
    done
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

reset_store
ALLOW_REVISIONS="rev1;rm" run 2026-09-20 2026-09-22 "$T/work" && no "bad ALLOW_REVISIONS accepted" || ok "malformed ALLOW_REVISIONS refused"
reset_store
ALLOW_REVISIONS=rev1,rev2 run 2026-09-20 2026-09-22 "$T/work" && grep -q -- "-allow-revisions rev1,rev2" "$T/finalize.args" &&
  ok "ALLOW_REVISIONS passed as -allow-revisions" || no "ALLOW_REVISIONS pass-through"

# ---- 3. pure functions ----
# shellcheck source=assemble.sh
source "$here/assemble.sh"
set +e
m="$T/merge"; mkdir -p "$m/a" "$m/b"
echo same > "$m/a/x"; echo same > "$m/b/x"; echo new > "$m/a/y"
( merge_unit "$m/a" "$m/b" ) && [[ -e "$m/b/y" && ! -e "$m/a" ]] && ok "merge_unit: equal files pass, new files moved, source removed" || no "merge_unit equal"
mkdir -p "$m/c"; echo other > "$m/c/x"
out=$( ( merge_unit "$m/c" "$m/b" ) 2>&1 ) && no "merge_unit accepted a mismatch" || { [[ "$out" == *"differs between days in x"* ]] && ok "merge_unit fails on a hash mismatch" || no "mismatch message: $out"; }
( merge_unit "$m/c" "$m/new/900/r" ) && [[ -e "$m/new/900/r/x" ]] && ok "merge_unit moves a new unit in" || no "merge_unit new"
[[ $(day_list 2026-09-20 2026-09-22 | wc -l) == 16 && $(day_list 2026-09-20 2026-09-22 | head -1) == 2026-09-06 ]] && ok "day_list: 14 lead-in days + window" || no "day_list"
ds="$T/big"; mkdir -p "$ds/days/2026-09-20" "$ds/qa"
for i in $(seq 1 995); do : > "$ds/days/2026-09-20/f$i"; done
echo '{}' > "$ds/manifest.json"; : > "$ds/qa/report.md"; : > "$ds/qa/report.json"; : > "$ds/qa/parity.json"
out=$( ( build_release "$ds" "$T/bigrel" ) 2>&1 ) && no "990-asset guard passed" || { [[ "$out" == *"990"* ]] && ok "more than 990 assets refused" || no "asset guard: $out"; }

echo "$pass passed, $fail failed"
(( fail == 0 ))
