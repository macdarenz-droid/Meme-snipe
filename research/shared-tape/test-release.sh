#!/usr/bin/env bash
# Tests release.sh with a fake gh (no network): three assets per unit, read back,
# a rerun is a no-op, a changed asset stops the run, only tape-* tags on zeroed-data.
set -uo pipefail
here=$(cd "$(dirname "$0")" && pwd)
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
cat > "$T/gh" <<'SH'
#!/usr/bin/env bash
# Fake gh: releases are directories under $FAKE_GH.
set -e
cmd="$1 $2"; shift 2
tag=$1; shift
repo=; files=(); pat=; dir=
while [ $# -gt 0 ]; do case $1 in -R) repo=$2; shift 2;; --json|--jq|--title|--notes) shift 2;; -p) pat=$2; shift 2;; -D) dir=$2; shift 2;; *) files+=("$1"); shift;; esac; done
[ "$repo" = macdarenz-droid/zeroed-data ] || { echo "wrong repo $repo" >&2; exit 9; }
[[ "$tag" == tape-* ]] || { echo "wrong tag $tag" >&2; exit 9; }
r="$FAKE_GH/$tag"
case $cmd in
  "release view") [ -d "$r" ] || exit 1; ls "$r" ;;
  "release create") mkdir -p "$r" ;;
  "release upload") for f in "${files[@]}"; do [ ! -e "$r/$(basename "$f")" ] || exit 8; cp "$f" "$r/"; done ;;
  "release download") cp "$r/$pat" "$dir/" ;;
esac
SH
chmod +x "$T/gh"; mkdir -p "$T/rel"
w="$T/work"; u="$w/day/units/1032/9000-13499"; r="$w/research/units/1032/9000-13499"; mkdir -p "$u" "$r" "$w/units/9000"
echo '{"blocks":1}' > "$u/stats.json"; head -c 5000 /dev/urandom > "$u/curve_trades.csv.zst"
echo '{}' > "$r/stats.json"; head -c 7000 /dev/urandom > "$r/F.csv.zst"
echo '{"attempts":1}' > "$w/units/9000/ledger.json"; echo 'identity: true' > "$w/units/9000/identity.txt"
pass=0 fail=0
ok() { echo "ok   $1"; pass=$((pass+1)); }
no() { echo "FAIL $1"; fail=$((fail+1)); }
run() { FAKE_GH="$T/rel" GH="$T/gh" bash "$here/release.sh" "$w" 2026-09-11 1032 9000 13499; }
out=$(run 2>&1); rc=$?
[[ $rc == 0 && $(ls "$T/rel/tape-2026-09-11" | wc -l) == 3 ]] && ok "three assets uploaded and read back" || no "rc=$rc $out"
tar -tf "$T/rel/tape-2026-09-11/records-9000-13499.tar" | grep -q identity.txt && ok "records hold the identity check" || no records
out=$(run 2>&1); rc=$?
[[ $rc == 0 && $(ls "$T/rel/tape-2026-09-11" | wc -l) == 3 ]] && ok "a rerun reuploads nothing (same sha256)" || no "rerun rc=$rc $out"
head -c 10 /dev/urandom >> "$T/rel/tape-2026-09-11/core-9000-13499.tar"
out=$(run 2>&1); rc=$?
[[ $rc != 0 && "$out" == *"read-back mismatch"* ]] && ok "a different existing asset stops the run" || no "mismatch rc=$rc"
echo "$pass passed, $fail failed"; [[ $fail == 0 ]]
