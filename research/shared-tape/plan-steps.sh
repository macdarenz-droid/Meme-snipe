#!/usr/bin/env bash
# Registers the Step B (2026-09-07..09-09) and Step C (2026-09-02..09-06) unit plans
# (parent ruling 2026-10-08, W1 amendment 5 Q36), in stepa-plan.txt's format: one unit
# per line, "DAY EPOCH FROM TO", newest first. Only block times are read
# (getBlocksWithLimit and getBlockTime, through a loopback tee at 1 request a second,
# capped at 800 credits); no block is fetched. Each day's units start with the unit
# holding its 00:00Z; Step B ends where Step A's first unit (stepa-plan.txt) begins, and
# Step C where Step B's begins, so no slot is planned twice.
#   plan-steps.sh WORK_DIR
set -uo pipefail
here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/../.." && pwd)
work=$1
upstream=${TAPE_UPSTREAM:-https://mainnet.helius-rpc.com/}
mkdir -p "$work"
log() { echo "$(date -u +%FT%TZ) $*" | tee -a "$work/plan-steps.log" >&2; }
testing=; [[ "${TAPE_TEST:-}" == 1 && "$upstream" == http://127.0.0.1:* ]] && testing=1
[[ "$upstream" =~ ^https://[a-z0-9.-]+\.helius-rpc\.com/ || -n "$testing" ]] || { log "refused: upstream"; exit 2; }
[ -n "${HELIUS_API_KEY:-}" ] || { log "refused: HELIUS_API_KEY is not set"; exit 2; }
bin="$work/bin"; mkdir -p "$bin"
(cd "$here/tapedec" && go build -o "$bin/zeroed-tapedec" .) || exit 1
tdir="$work/plan-steps"; rm -rf "$tdir"; mkdir -p "$tdir"
"$bin/zeroed-tapedec" tee -upstream "$upstream" -rps 1 -max-credits 800 -spool "$tdir/spool" \
  -ledger "$tdir/ledger.json" -stop-file "$tdir/STOP" -addr-file "$tdir/tee.addr" 2>> "$work/plan-steps.log" &
teepid=$!
trap 'kill -INT $teepid 2>/dev/null; wait $teepid 2>/dev/null' EXIT
for _ in $(seq 50); do [ -s "$tdir/tee.addr" ] && break; sleep 0.2; done
tee_url="http://$(cat "$tdir/tee.addr")/"
rpc() { curl -sS --max-time 60 -H 'Content-Type: application/json' \
  -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"$1\",\"params\":$2}" "$tee_url" | jq -c '.result'; }

# Slot estimate from regimes.json anchors: B2 (2026-07-21T14:23Z, 434319990), B3
# (2026-09-09T19:30Z, pump_amm 445691021), B4 (2026-09-12T15:24Z, 446462733).
est_slot() {
  local t=$1 b2t b3t b4t
  b2t=$(date -u -d 2026-07-21T14:23Z +%s); b3t=$(date -u -d 2026-09-09T19:30Z +%s); b4t=$(date -u -d 2026-09-12T15:24Z +%s)
  if (( t < b3t )); then echo $(( 434319990 + (t - b2t) * (445691021 - 434319990) / (b3t - b2t) ))
  else echo $(( 445691021 + (t - b3t) * (446462733 - 445691021) / (b4t - b3t) )); fi
}
first_at_or_after() { # T -> the first produced slot whose block time is >= T
  local t=$1 lo hi mid s bt est
  est=$(est_slot "$t"); lo=$(( est - 150000 )) hi=$(( est + 150000 ))
  s_time() { s=$(rpc getBlocksWithLimit "[$1,1,{\"commitment\":\"finalized\"}]" | jq -r '.[0]'); bt=$(rpc getBlockTime "[$s]"); [[ "$bt" =~ ^[0-9]+$ ]]; }
  # Widen until the window brackets t (the estimate can be off by a day or more).
  local k
  for k in 1 2 3 4 5 6; do s_time "$lo" || return 1; (( bt < t )) && break; lo=$(( lo - 150000 * k )); done
  (( bt < t )) || { log "low end $lo not before $t"; return 1; }
  for k in 1 2 3 4 5 6; do s_time "$hi" || return 1; (( bt >= t )) && break; hi=$(( hi + 150000 * k )); done
  (( bt >= t )) || { log "high end $hi not after $t"; return 1; }
  while (( hi - lo > 1 )); do
    mid=$(( (lo + hi) / 2 ))
    s_time "$mid" || return 1
    if (( bt >= t )); then hi=$mid; else lo=$mid; fi
  done
  s_time "$hi" || return 1
  echo "$s"
}

# Day starts 09-02..09-09; Step A's first unit bounds Step B from above.
declare -A start
for d in 2026-09-02 2026-09-03 2026-09-04 2026-09-05 2026-09-06 2026-09-07 2026-09-08 2026-09-09; do
  start[$d]=$(first_at_or_after "$(date -u -d "$d" +%s)") || { log "boundary $d failed"; exit 1; }
  log "first slot of $d: ${start[$d]}"
done
a_first=$(tail -1 "$here/stepa-plan.txt" | awk '{print $3}') # Step A's lowest unit start
write_plan() { # OUT DAY... (oldest first): units from each day's first unit to the next day's, newest first
  local out=$1; shift
  local days=("$@") stop=$2 i u from d
  : > "$out.tmp"
  for (( i = ${#days[@]} - 1; i >= 0; i-- )); do
    d=${days[$i]}
    from=$(( start[$d] / 4500 * 4500 ))
    if (( i == ${#days[@]} - 1 )); then stop=$END; else stop=$(( start[${days[$((i+1))]}] / 4500 * 4500 )); fi
    for (( u = stop - 4500; u >= from; u -= 4500 )); do
      echo "$d $(( u / 432000 )) $u $(( u + 4499 ))" >> "$out.tmp"
    done
  done
  mv "$out.tmp" "$out"
}
END=$a_first write_plan "$here/stepb-plan.txt" 2026-09-07 2026-09-08 2026-09-09
b_first=$(tail -1 "$here/stepb-plan.txt" | awk '{print $3}')
END=$b_first write_plan "$here/stepc-plan.txt" 2026-09-02 2026-09-03 2026-09-04 2026-09-05 2026-09-06
for p in stepb stepc; do
  (cd "$here" && sha256sum "$p-plan.txt" > "$p-plan.sha256")
  log "$p: $(wc -l < "$here/$p-plan.txt") units, $(cut -d' ' -f1 "$here/$p-plan.sha256")"
done
kill -INT $teepid; wait $teepid 2>/dev/null; trap - EXIT
log "credits: $(jq .attempts "$tdir/ledger.json"); blocks fetched: $(jq '.methods.getBlock.attempts // 0' "$tdir/ledger.json")"
