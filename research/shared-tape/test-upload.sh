#!/usr/bin/env bash
# Tests upload.sh against a local stand-in for zeroed-data (no network).
set -uo pipefail
here=$(cd "$(dirname "$0")" && pwd)
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
pass=0 fail=0
ok() { echo "ok   $1"; pass=$((pass+1)); }
no() { echo "FAIL $1"; fail=$((fail+1)); }
remote="$T/macdarenz-droid/zeroed-data.git"
mkdir -p "$(dirname "$remote")"
git init -q --bare -b main "$remote"
git -C "$remote" config uploadpack.allowFilter true
git clone -q "$remote" "$T/seed" 2>/dev/null
mkdir -p "$T/seed/reports"; echo '{"day":"x"}' > "$T/seed/reports/latest.json"
git -C "$T/seed" add -A && git -C "$T/seed" -c user.name=t -c user.email=t@t commit -qm seed && git -C "$T/seed" push -q origin main
git -C "$remote" tag rec-2026-10-04 main
main0=$(git -C "$remote" rev-parse main)
git clone -q --depth 1 "file://$remote" "$T/clone"

src="$T/src"; mkdir -p "$src/units/1032/a" "$src/research"
head -c 1000 /dev/urandom > "$src/units/1032/a/stats.json"
head -c 120000000 /dev/urandom > "$src/research/big.csv.zst"   # above 95 MB: split
echo hello > "$src/research/small.txt"

out=$(bash "$here/upload.sh" "$src" 2026-09-11/phase0 "$T/clone" 2>&1); rc=$?
[[ $rc == 0 && "$out" == *"uploaded and read back: tape/2026-09-11/phase0"* ]] && ok "first upload creates the tape branch and reads back" || no "first upload: rc=$rc $out"
[[ $(git -C "$remote" rev-parse main) == "$main0" && $(git -C "$remote" rev-parse rec-2026-10-04) == "$main0" ]] && ok "main and rec-* tags untouched" || no "main or a tag moved"
files=$(git -C "$remote" ls-tree -r --name-only tape)
grep -qv '^tape/' <<<"$files" && no "a path outside tape/ on the tape branch" || ok "every path on the tape branch is under tape/"
git -C "$remote" merge-base main tape >/dev/null 2>&1 && no "tape shares history with main" || ok "tape shares no history with main"
big=$(git -C "$remote" ls-tree -r -l tape | awk '$4 > 100000000' | wc -l)
[[ $big == 0 ]] && grep -q 'big.csv.zst.part000' <<<"$files" && ok "files above 95 MB are split; no git file above 100 MB" || no "split: big=$big"
out=$(bash "$here/upload.sh" "$src" 2026-09-11/phase0 "$T/clone" 2>&1); rc=$?
[[ $rc == 2 && "$out" == *"already exists"* ]] && ok "an existing tape path is never overwritten" || no "overwrite: rc=$rc $out"
out=$(bash "$here/upload.sh" "$src" 2026-09-11/unit2 "$T/clone" 2>&1); rc=$?
n=$(git -C "$remote" ls-tree -r --name-only tape | grep -c 'phase0/SHA256SUMS')
[[ $rc == 0 && $n == 1 ]] && ok "a second upload adds to the branch and keeps the first" || no "second upload: rc=$rc $out"
out=$(bash "$here/upload.sh" "$src" ../main "$T/clone" 2>&1); rc=$?
[[ $rc == 2 ]] && ok "a destination outside tape/<day> is refused" || no "bad dest: rc=$rc"
echo "$pass passed, $fail failed"
[[ $fail == 0 ]]
