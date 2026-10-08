#!/usr/bin/env bash
# Uploads one finished unit to release tape-DAY on macdarenz-droid/zeroed-data as three
# assets (owner, 2026-10-08: gh only for tape-* release assets there), then downloads
# each back and checks its sha256. Existing assets and other releases are never
# changed: an asset that already exists with the same sha256 counts as done, a
# different one stops the run.
#   release.sh WORK DAY EPOCH FROM TO
# Assets: core-FROM-TO.tar (the core unit), research-FROM-TO.tar (the research tables),
# records-FROM-TO.tar (ledger, usage, identity, decode stats, getBlock manifest). The
# tables inside are already zstd; tar adds no compression. Done units are listed in
# WORK/released.tsv (day, unit, asset, sha256, bytes).
set -euo pipefail
work=$1 day=$2 ep=$3 from=$4 to=$5
repo=macdarenz-droid/zeroed-data
tag="tape-$day"
gh=${GH:-gh}
[[ "$day" =~ ^20[0-9]{2}-[0-9]{2}-[0-9]{2}$ ]] || { echo "bad day $day" >&2; exit 2; }
unit="$work/day/units/$ep/$from-$to" rdir="$work/research/units/$ep/$from-$to"
[ -f "$unit/stats.json" ] && [ -f "$rdir/stats.json" ] || { echo "unit $from-$to is not finished" >&2; exit 2; }
# Records: Step A units keep them in WORK/units/FROM; the Phase 0 unit in WORK.
rec="$work/units/$from"; [ -f "$rec/ledger.json" ] || rec="$work"
tmp=$(mktemp -d "$work/rel.XXXXXX"); trap 'rm -rf "$tmp"' EXIT
tar -C "$unit" -cf "$tmp/core-$from-$to.tar" --sort=name --mtime=@0 --owner=0 --group=0 .
tar -C "$rdir" -cf "$tmp/research-$from-$to.tar" --sort=name --mtime=@0 --owner=0 --group=0 .
files=()
for f in ledger.json rpcscan-usage.json identity.txt decode-stats.json getblock-manifest.tsv digest-compare.json; do
  [ -f "$rec/$f" ] && files+=("$f")
done
tar -C "$rec" -cf "$tmp/records-$from-$to.tar" --sort=name --mtime=@0 --owner=0 --group=0 "${files[@]}"
for f in "$tmp"/*.tar; do
  [ "$(stat -c %s "$f")" -lt 2000000000 ] || { echo "$f above 2 GB" >&2; exit 1; }
done

if ! "$gh" release view "$tag" -R "$repo" --json tagName >/dev/null 2>&1; then
  "$gh" release create "$tag" -R "$repo" --title "$tag" \
    --notes "Shared tape, $day (research/SHARED_TAPE_PLAN.md). Private research data: never published." >/dev/null
fi
existing=$("$gh" release view "$tag" -R "$repo" --json assets --jq '.assets[].name')
mkdir -p "$tmp/back"
for f in "$tmp"/*.tar; do
  name=$(basename "$f")
  sum=$(sha256sum < "$f" | cut -d' ' -f1)
  if ! grep -qx "$name" <<<"$existing"; then
    n=0; until "$gh" release upload "$tag" -R "$repo" "$f" >/dev/null; do
      n=$((n+1)); [ $n -gt 4 ] && { echo "upload of $name failed" >&2; exit 1; }; sleep $((2**n))
      # An upload that reported failure may have landed: then read it back instead.
      "$gh" release view "$tag" -R "$repo" --json assets --jq '.assets[].name' | grep -qx "$name" && break
    done
  fi
  rm -f "$tmp/back/$name"
  "$gh" release download "$tag" -R "$repo" -p "$name" -D "$tmp/back" >/dev/null
  got=$(sha256sum < "$tmp/back/$name" | cut -d' ' -f1)
  [ "$got" = "$sum" ] || { echo "read-back mismatch: $tag/$name" >&2; exit 1; }
  rm -f "$tmp/back/$name"
  printf '%s\t%s-%s\t%s\t%s\t%s\n' "$day" "$from" "$to" "$name" "$sum" "$(stat -c %s "$f")" >> "$work/released.tsv"
done
echo "released and read back: $tag $from-$to"
