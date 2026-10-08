#!/usr/bin/env bash
# Shared tape Phase 0 (research/SHARED_TAPE_PLAN.md, STEPWISE PULL): the first whole
# 4,500-slot unit of 2026-09-11, read once by the unchanged rpcscan through the loopback
# tee, decoded, uploaded to zeroed-data (branch tape) and read back. It stops there.
#   phase0.sh WORK_DIR [RPS [RPS2 SWITCH_AFTER]]
# RPS (default 10, at most 25) is the tee's rate for this process; RPS2 from attempt
# SWITCH_AFTER on. HELIUS_API_KEY comes from the environment and is never printed; rpcscan
# gets a placeholder. The unit is written where rpc-day.sh's rpc-run would write it
# (units/EPOCH/FROM-TO), so Step A's run skips it.
set -uo pipefail
here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/../.." && pwd)
day=2026-09-11
work=$1 rps=${2:-10} rps2=${3:-0} switch=${4:-0}
cap=6000 # credits for Phase 0 across every run: one unit is about 4,844 calls with retries (plan, CREDITS)
zdata=${ZEROED_DATA:-/home/user/zeroed-data}
mkdir -p "$work"
log() { echo "$(date -u +%FT%TZ) $*" | tee -a "$work/phase0.log" >&2; } # stderr: safe inside $(...)

# The real key goes only to Helius; test-phase0.sh sets TAPE_TEST=1 for its local fake.
upstream=${TAPE_UPSTREAM:-https://mainnet.helius-rpc.com/}
[[ "$upstream" =~ ^https://[a-z0-9.-]+\.helius-rpc\.com/ || "${TAPE_TEST:-}" == 1 ]] || { log "refused: upstream must be https://*.helius-rpc.com/"; exit 2; }
. "$root/research/historical/ci/archive-limits.conf"
[[ " $HELIUS_DAYS " == *" $day "* ]] || { log "refused: $day is not in HELIUS_DAYS"; exit 2; }
[ -n "${HELIUS_API_KEY:-}" ] || { log "refused: HELIUS_API_KEY is not set"; exit 2; }
free=$(df -B1 --output=avail "$work" | tail -1)
(( free > 14 * 1024**3 )) || { log "refused: $free bytes free, need 14 GiB (8 GiB floor + the unit)"; exit 2; }
[ -z "$(git -C "$root" status --porcelain -- research/shared-tape research/historical)" ] || { log "refused: uncommitted changes under research/shared-tape or research/historical"; exit 2; }

# Builds: rpcscan exactly as data-scan.yml builds it; the tapedec at its committed tree.
bin="$work/bin"; mkdir -p "$bin"
export GO_VERSION=${GO_VERSION:-$(sed -n 's/^ *GO_VERSION: *"\([0-9.]*\)".*/\1/p' "$root/.github/workflows/data-scan.yml" | head -1)}
rev=$(cd "$root" && research/historical/ci/rpcscan-rev.sh) || { log "rpcscan revision failed (GO_VERSION $GO_VERSION)"; exit 1; }
(cd "$root/research/historical/rpcscan" && go build -trimpath -ldflags "-X main.scannerRevision=$rev" -o "$bin/zeroed-rpcscan" .) || exit 1
trev="tapedec$(git -C "$root" rev-parse HEAD:research/shared-tape/tapedec)"
(cd "$here/tapedec" && go build -trimpath -ldflags "-X main.scannerRevision=$trev" -o "$bin/zeroed-tapedec" .) || exit 1
log "rpcscan revision $rev; decoder $trev"

out="$work/day"; spool="$work/spool"; mkdir -p "$out" "$spool"
# The cap holds across reruns: every run's forwarded attempts are added to credits-used.
used=$(cat "$work/credits-used" 2>/dev/null || echo 0)
left=$(( cap - used ))
(( left > 0 )) || { log "refused: Phase 0's $cap credits are spent ($used used)"; exit 3; }
rm -f "$work/STOP" "$work/tee.addr" "$work/ledger.json"
"$bin/zeroed-tapedec" tee -upstream "$upstream" -rps "$rps" -rps2 "$rps2" -switch-after "$switch" -max-credits "$left" -spool "$spool" \
  -ledger "$work/ledger.json" -stop-file "$work/STOP" -addr-file "$work/tee.addr" 2>> "$work/tee.log" &
teepid=$!
stop_tee() {
  kill -INT $teepid 2>/dev/null; wait $teepid 2>/dev/null
  local a; a=$(jq -r '.attempts' "$work/ledger.json" 2>/dev/null || echo "")
  [[ "$a" =~ ^[0-9]+$ ]] || a=$left # unreadable ledger: book the whole allowance (fail closed)
  echo $(( used + a )) > "$work/credits-used"
  log "credits booked: $(( used + a )) of $cap"
}
trap stop_tee EXIT
for _ in $(seq 50); do [ -s "$work/tee.addr" ] && break; sleep 0.2; done
addr=$(cat "$work/tee.addr") || { log "tee did not start"; exit 1; }
tee_url="http://$addr/"

rpc() { # METHOD PARAMS_JSON -> result (through the tee, counted in its ledger)
  curl -sS --max-time 60 -H 'Content-Type: application/json' \
    -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"$1\",\"params\":$2}" "$tee_url" | jq -c '.result'
}
# The first whole unit of the day: the unit after the one holding 00:00Z, estimated
# from the B3 and B4 slot anchors (research/historical/regimes.json), then checked
# with getBlocksWithLimit and getBlockTime (a few credits).
t0=$(date -u -d "$day" +%s); t1=$((t0 + 86400))
b3t=$(date -u -d 2026-09-09T19:30Z +%s); b4t=$(date -u -d 2026-09-12T15:24Z +%s)
est=$(( 445691021 + (t0 - b3t) * (446462733 - 445691021) / (b4t - b3t) ))
ep=$(( est / 432000 )); efirst=$(( ep * 432000 )); elast=$(( efirst + 431999 ))
from=$(( efirst + ((est - efirst) / 4500 + 1) * 4500 ))
first_time() { # UNIT_START -> time of the unit's first block
  local f b
  f=$(rpc getBlocksWithLimit "[$1,1,{\"commitment\":\"finalized\"}]" | jq -r '.[0]')
  b=$(rpc getBlockTime "[$f]")
  [[ "$b" =~ ^[0-9]+$ ]] || { log "getBlockTime($f) failed"; return 1; }
  log "unit $1: first block $f at $(date -u -d @"$b" +%FT%TZ)"
  echo "$b"
}
# Forward while the candidate starts before the day; back while the unit before it
# also starts inside the day (the estimate overshot).
bt=0 pbt=0
for try in 1 2 3 4 5 6; do
  bt=$(first_time "$from") || exit 1
  (( bt < t0 )) && { from=$(( from + 4500 )); continue; }
  pbt=$(first_time $(( from - 4500 ))) || exit 1
  (( pbt >= t0 )) && { from=$(( from - 4500 )); continue; }
  break
done
(( bt >= t0 && pbt < t0 && bt < t0 + 7200 )) || { log "no first whole unit found at the start of $day"; exit 1; }
to=$(( from + 4499 )); (( to > elast )) && to=$elast
(( from / 432000 == ep )) || { log "unit crosses an epoch"; exit 1; }
log "Phase 0 unit: epoch $ep slots $from-$to"

start=$(date +%s)
timeout -s INT -k 120 3h env HELIUS_API_KEY=placeholder "$bin/zeroed-rpcscan" rpc-unit -out "$out" -epoch "$ep" \
  -from-slot "$from" -to-slot "$to" -sample 0.05 -helius-url "$tee_url" -rps 25 -conc "${RPC_CONC:-8}" \
  -max-credits "$cap" -usage-out "$work/rpcscan-usage.json" 2>> "$work/rpcscan.log"
rc=$?
secs=$(( $(date +%s) - start ))
log "rpcscan exit $rc after ${secs}s"
stop_tee; trap - EXIT
[ -f "$work/STOP" ] && log "tee stopped: $(cat "$work/STOP")"
grep -qF -f <(printf '%s\n' "$HELIUS_API_KEY") "$work"/*.log "$work"/*.json 2>/dev/null && { log "KEY FOUND IN A LOG: stopping"; exit 1; }
[ "$rc" -eq 0 ] || { log "rpcscan did not finish the unit (exit $rc); progress kept, nothing uploaded"; exit "$rc"; }

# Identity: the tee's counters equal rpcscan's own.
u="$work/rpcscan-usage.json" l="$work/ledger.json"
ident=false
"$bin/zeroed-tapedec" identity -usage "$u" -ledger "$l" >> "$work/phase0.log" 2>&1 && ident=true
log "identity (credits, requests, bytes; selection calls excluded): $ident"
unit="$out/units/$ep/$from-$to"
"$bin/zeroed-rpcscan" rpc-unit -out "$work/replay" -epoch "$ep" -from-slot "$from" -to-slot "$to" -sample 0.05 -dir "$spool" 2>> "$work/rpcscan.log" &&
  "$bin/zeroed-rpcscan" digest -unit "$unit" -o "$work/live-digest.json.zst" &&
  "$bin/zeroed-rpcscan" digest-compare -baseline "$work/live-digest.json.zst" -unit "$work/replay/units/$ep/$from-$to" > "$work/digest-compare.json"
replay=$?
log "replay from the spool equals the live unit: $([ $replay -eq 0 ] && echo true || echo false)"
rm -rf "$work/replay"
[[ "$ident" == true && $replay -eq 0 ]] || { log "identity failed: nothing uploaded"; exit 1; }

dstart=$(date +%s)
TIMEFORMAT='decode: real %R s, user %U s, sys %S s'
{ time "$bin/zeroed-tapedec" decode -spool "$spool" -from-slot "$from" -to-slot "$to" -day "$day" \
  -out "$work/research/units/$ep/$from-$to" > "$work/decode-stats.json" 2>> "$work/decode.log"; } 2>> "$work/decode.log" || { log "decode failed"; exit 1; }
log "$(tail -1 "$work/decode.log")"
# The decoded unit is complete: every block of the core unit was decoded or dropped.
cb=$(jq -r '.blocks' "$unit/stats.json"); db=$(jq -r '.blocks + .dropped_blocks' "$work/decode-stats.json")
[[ "$cb" == "$db" && "$(jq -r '.manifest_verified' "$work/decode-stats.json")" == "$cb" ]] || { log "decode incomplete: core $cb blocks, decoded $db"; exit 1; }

# Upload the core unit, the research tables and the run's records; read them back.
up="$work/upload"; rm -rf "$up"; mkdir -p "$up/core" "$up/research" "$up/records"
cp -r "$out/units" "$up/core/"
cp -r "$work/research/units" "$up/research/"
cp "$l" "$u" "$work/decode-stats.json" "$work/digest-compare.json" "$up/records/"
cp "$spool/MANIFEST.tsv" "$up/records/getblock-manifest.tsv"
grep -rqF -f <(printf '%s\n' "$HELIUS_API_KEY") "$up" "$work"/*.log 2>/dev/null && { log "KEY FOUND IN THE UPLOAD: stopping"; exit 1; }
bash "$here/upload.sh" "$up" "$day/phase0" "$zdata" 2>&1 | tee -a "$work/phase0.log"
[ "${PIPESTATUS[0]}" -eq 0 ] || { log "upload failed"; exit 1; }
du -sb "$unit" "$work/research" "$spool" > "$work/disk.txt"
log "Phase 0 done: unit $ep/$from-$to, ${secs}s of requests"
