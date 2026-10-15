#!/usr/bin/bash
# Stores one day's regime volume per hour as release data-volume-DAY (DATA-1c): the
# plain CSV volume-hours-DAY.csv (hour_start_ms,lamports,covered) and its cross-check
# volume-check-DAY.json. Its own release, so the day's data release (data-day-DAY,
# never edited) keeps its asset set. Same rules as publish-day.sh: run under env -i with
# gh by absolute path; created in one call; an existing release is never edited: equal
# CSV content is accepted, anything else fails ("delete it to republish"). OF-4: in the
# private store only (--repo "$DATA_REPO", GH_TOKEN the store token), never this
# repository; after storing, both files are read back and compared.
#   publish-volume.sh DAY ASSET_DIR
set -euo pipefail
GH=${GH_BIN:-/usr/bin/gh}
[[ "${DATA_REPO:-}" =~ ^[A-Za-z0-9-]+/[A-Za-z0-9._-]+$ ]] || { echo "refused: DATA_REPO (the private store) is not set"; exit 1; }
this_repo=${GITHUB_REPOSITORY:-}
[[ "${DATA_REPO,,}" != "${this_repo,,}" ]] || { echo "refused: DATA_REPO is this repository, not the private store"; exit 1; }
d=$1 assets=$2
[[ "$d" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]] || { echo "bad day $d"; exit 1; }
# DATA-PUB: a day read over RPC (source helius) is never published. Its units carry raw
# getBlock responses, which may not leave the actions cache; the manifest names each
# unit's source, and an RPC unit's root_cid is "rpc:getBlock" (rpcscan/rpcunit.go).
if grep -Eq '"root_cid": *"rpc:' "$assets/manifest-$d.json" 2>/dev/null; then
  echo "refused: manifest-$d.json lists units read over RPC (a helius day is never published)"; exit 1
fi
summary=${GITHUB_STEP_SUMMARY:-/dev/null}
csv="$assets/volume-hours-$d.csv" check="$assets/volume-check-$d.json"
for f in "$csv" "$check"; do [ -f "$f" ] || { echo "missing $f"; exit 1; }; done
# shape: header + 24 hours of this day, covered 0 or 1
start=$(date -u -d "$d" +%s)
awk -F, -v s="$start" 'NR==1 { if ($0 != "hour_start_ms,lamports,covered") exit 1; next }
  { if ($1 != (s + (NR-2)*3600) * 1000 || $2 !~ /^[0-9]+$/ || ($3 != "0" && $3 != "1")) exit 1 }
  END { if (NR != 25) exit 1 }' "$csv" || { echo "$csv is not 24 hours of $d"; exit 1; }
grep -q '"mismatches": \[\]' "$check" && grep -q '"problems": \[\]' "$check" || { echo "$check reports mismatches"; exit 1; }
tag="data-volume-$d"
err=$(mktemp)
if info=$("$GH" release view "$tag" --repo "$DATA_REPO" --json isDraft,assets --jq '"draft \(.isDraft)", (.assets[] | "asset \(.name) \(.state)")' 2>"$err"); then
  rm -f "$err"
  tmp=$(mktemp -d)
  if grep -qx "draft false" <<<"$info" && "$GH" release download "$tag" --repo "$DATA_REPO" --pattern "volume-hours-$d.csv" --dir "$tmp" >/dev/null 2>&1 &&
    cmp -s "$tmp/volume-hours-$d.csv" "$csv"; then
    rm -rf "$tmp"
    echo "release $tag is already stored with the same volume hours; left unchanged" | tee -a "$summary"
    exit 0
  fi
  rm -rf "$tmp"
  echo "$tag exists with other content; delete it to republish (never edited here)" | tee -a "$summary"
  exit 1
fi
grep -qi "release not found" "$err" || { echo "gh error: $(tr '\n' ' ' < "$err")"; rm -f "$err"; exit 1; }
rm -f "$err"
"$GH" release create "$tag" --repo "$DATA_REPO" --prerelease --title "Regime volume per hour: $d" \
  --notes "SOL-quoted pump curve and canonical PumpSwap volume per UTC hour of $d, lamports, buys plus sells; covered = the whole hour was scanned. From .github/workflows/data-scan.yml at ${GITHUB_SHA:-unknown}. Format: docs/research/historical-data.md." \
  -- "$csv" "$check"
# OF-4 read-back: both stored files equal the local ones.
rb=$(mktemp -d)
for f in "$csv" "$check"; do
  "$GH" release download "$tag" --repo "$DATA_REPO" --pattern "$(basename "$f")" --dir "$rb" >/dev/null 2>&1 && cmp -s "$rb/$(basename "$f")" "$f" ||
    { rm -rf "$rb"; echo "read-back: $(basename "$f") in $tag differs or cannot be read" | tee -a "$summary"; exit 1; }
done
rm -rf "$rb"
echo "stored $tag in the private store; read back" | tee -a "$summary"
