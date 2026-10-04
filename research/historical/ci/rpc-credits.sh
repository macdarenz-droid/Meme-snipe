#!/usr/bin/env bash
# The running credit total of an RPC day (rpc-day.sh, check-day.sh), kept in
# OUT/rpc-credits-used so the cap holds across chained runs.
#   rpc-credits.sh get OUT          prints the credits used so far (0 when none)
#   rpc-credits.sh add OUT USAGE    adds the "credits" of a zeroed-rpcscan usage file
# A missing usage file adds nothing; a malformed one fails (a total that silently drops
# spent credits would let the cap be passed).
set -euo pipefail
cmd=$1 out=$2
f="$out/rpc-credits-used"
cur=0
[ -f "$f" ] && cur=$(cat "$f")
[[ "$cur" =~ ^[0-9]+$ ]] || { echo "rpc-credits: bad total '$cur' in $f" >&2; exit 1; }
case $cmd in
  get) echo "$cur" ;;
  add)
    [ -f "${3:-}" ] || exit 0
    n=$(sed -n 's/^ *"credits": *\([0-9][0-9]*\),*$/\1/p' "$3" | head -1)
    [[ "$n" =~ ^[0-9]+$ ]] || { echo "rpc-credits: no credits in $3" >&2; exit 1; }
    echo $(( cur + n )) > "$f.tmp" && mv "$f.tmp" "$f"
    ;;
  *) echo "usage: rpc-credits.sh get|add OUT [USAGE]" >&2; exit 2 ;;
esac
