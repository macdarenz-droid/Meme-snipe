#!/usr/bin/env bash
# Shared tape Step A (research/SHARED_TAPE_PLAN.md; parent rulings 2026-10-08): the days
# 2026-09-11 then 2026-09-10, read unit by unit by the unchanged rpcscan (the binary and
# -sample of rpc-day.sh) through a fresh loopback tee per unit, so each unit's identity is
# checked on its own (tee counters = rpcscan counters; the decoder checks every block
# against the tee's sha256 manifest). Resumable: a unit with core and research stats is
# skipped; a unit's spool is deleted only after its research tables are written.
# Rulings: no block at or after 2026-09-12T00:00Z is read (U1-B's holdout): the last unit
# is clipped at the last slot before it. Each unit is read once (09-10's units stop where
# 09-11's begin). No margin units: the day's first unit is the one holding 00:00Z.
#   stepa.sh WORK_DIR
# Env: RPS (tee, default 25, at most 25), RPC_CONC (default 32), STEPA_CAP (credits for
# Step A across runs, default 650000 = 1.15 x two days at the Phase 0 rate),
# REPLAY_EVERY (digest replay of every Nth unit, default 30; 0 = none).
set -uo pipefail
here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/../.." && pwd)
work=$1
days=(2026-09-11 2026-09-10)
holdout=$(date -u -d 2026-09-12 +%s)
store=${STORE:-hf} # hf: the owner's private dataset Mrcdrnz/zeroed-tape (hfstore.py); release: tape-* release assets
keep=${KEEP_LOCAL:-0} # 1: no release; finished units stay local (release creation was refused, 2026-10-08)
max=${MAX_UNITS:-0} # read at most this many units in this run (0: all; tests and staged starts)
rps=${RPS:-25} conc=${RPC_CONC:-32} cap=${STEPA_CAP:-650000} every=${REPLAY_EVERY:-30}
upstream=${TAPE_UPSTREAM:-https://mainnet.helius-rpc.com/}
mkdir -p "$work"
log() { echo "$(date -u +%FT%TZ) $*" | tee -a "$work/stepa.log" >&2; }
# TAPE_TEST=1 (test-stepa.sh) counts only with a loopback upstream.
testing=; [[ "${TAPE_TEST:-}" == 1 && "$upstream" == http://127.0.0.1:* ]] && testing=1
[[ "$upstream" =~ ^https://[a-z0-9.-]+\.helius-rpc\.com/ || -n "$testing" ]] || { log "refused: upstream must be https://*.helius-rpc.com/"; exit 2; }
. "$root/research/historical/ci/archive-limits.conf"
for d in "${days[@]}"; do [[ " $HELIUS_DAYS " == *" $d "* ]] || { log "refused: $d is not in HELIUS_DAYS"; exit 2; }; done
[ -n "${HELIUS_API_KEY:-}" ] || { log "refused: HELIUS_API_KEY is not set"; exit 2; }
[ -n "$testing" ] || command -v gh >/dev/null || { log "refused: gh is not installed"; exit 2; }
[ -z "$(git -C "$root" status --porcelain -- research/shared-tape research/historical)" ] || { log "refused: uncommitted changes under research/shared-tape or research/historical"; exit 2; }

export GO_VERSION=${GO_VERSION:-$(sed -n 's/^ *GO_VERSION: *"\([0-9.]*\)".*/\1/p' "$root/.github/workflows/data-scan.yml" | head -1)}
bin="$work/bin"; mkdir -p "$bin"
rev=$(cd "$root" && research/historical/ci/rpcscan-rev.sh) || { log "rpcscan revision failed"; exit 1; }
(cd "$root/research/historical/rpcscan" && go build -trimpath -ldflags "-X main.scannerRevision=$rev" -o "$bin/zeroed-rpcscan" .) || exit 1
trev="tapedec$(git -C "$root" rev-parse HEAD:research/shared-tape/tapedec)"
(cd "$here/tapedec" && go build -trimpath -ldflags "-X main.scannerRevision=$trev" -o "$bin/zeroed-tapedec" .) || exit 1
log "Step A: rpcscan $rev; decoder $trev; rps $rps conc $conc cap $cap"

out="$work/day"; res="$work/research"; mkdir -p "$out" "$res" "$work/units"
credits="$work/stepa-credits-used"
used() { # fails closed: an unreadable count stops the run
  local v; v=$(cat "$credits" 2>/dev/null || echo 0)
  [[ "$v" =~ ^[0-9]+$ ]] || { log "credit count unreadable: stopping"; kill -TERM $$; exit 1; }
  echo "$v"
}
book() { echo "$1" > "$credits.tmp" && mv "$credits.tmp" "$credits"; }
key_check() { # fail closed if the key is in any log or record
  ! grep -rqF -f <(printf '%s\n' "$HELIUS_API_KEY") "$work"/*.log "$work"/units 2>/dev/null
}

# --- A tee for one unit or for planning calls -------------------------------------
teepid= tee_url= tdir= tleft= tbase=
start_tee() { # DIR CAP: the whole cap is booked first (a hard kill loses nothing), then corrected
  tdir=$1 tleft=$2; mkdir -p "$tdir"
  tbase=$(used) || exit 1; book $(( tbase + tleft ))
  rm -f "$tdir/STOP" "$tdir/tee.addr" "$tdir/ledger.json"
  "$bin/zeroed-tapedec" tee -upstream "$upstream" -rps "$rps" -max-credits "$tleft" -spool "$tdir/spool" \
    -ledger "$tdir/ledger.json" -stop-file "$tdir/STOP" -addr-file "$tdir/tee.addr" 2>> "$work/tee.log" &
  teepid=$!
  for _ in $(seq 50); do [ -s "$tdir/tee.addr" ] && break; sleep 0.2; done
  [ -s "$tdir/tee.addr" ] || { log "tee did not start"; return 1; }
  tee_url="http://$(cat "$tdir/tee.addr")/"
}
stop_tee() { # books the tee's attempts (the whole allowance if the ledger is unreadable)
  [ -n "$teepid" ] || return 0
  kill -INT "$teepid" 2>/dev/null; wait "$teepid" 2>/dev/null
  local a; a=$(jq -r '.attempts' "$tdir/ledger.json" 2>/dev/null || echo "")
  [[ "$a" =~ ^[0-9]+$ ]] || a=$tleft
  book $(( tbase + a ))
  teepid=
}
trap 'stop_tee; wait' EXIT
rpc() { curl -sS --max-time 60 -H 'Content-Type: application/json' \
  -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"$1\",\"params\":$2}" "$tee_url" | jq -c '.result'; }

# first_at_or_after T: the first produced slot whose block time is >= T (binary search
# over getBlocksWithLimit and getBlockTime; it reads block times only, never a block).
first_at_or_after() {
  local t=$1 lo hi mid s bt
  local b3t b4t; b3t=$(date -u -d 2026-09-09T19:30Z +%s); b4t=$(date -u -d 2026-09-12T15:24Z +%s)
  local est=$(( 445691021 + (t - b3t) * (446462733 - 445691021) / (b4t - b3t) ))
  lo=$(( est - 60000 )) hi=$(( est + 60000 ))
  s_time() { s=$(rpc getBlocksWithLimit "[$1,1,{\"commitment\":\"finalized\"}]" | jq -r '.[0]'); bt=$(rpc getBlockTime "[$s]"); [[ "$bt" =~ ^[0-9]+$ ]]; }
  s_time "$lo" && (( bt < t )) || { log "search low end $lo not before $t"; return 1; }
  s_time "$hi" && (( bt >= t )) || { log "search high end $hi not after $t"; return 1; }
  # P(x): the first produced slot at or after x has time >= t (monotone in x).
  while (( hi - lo > 1 )); do
    mid=$(( (lo + hi) / 2 ))
    s_time "$mid" || return 1
    if (( bt >= t )); then hi=$mid; else lo=$mid; fi
  done
  s_time "$hi" || return 1
  echo "$s"
}

# --- Plan (cached in plan.txt: "DAY EPOCH FROM TO" per unit, newest day first) -----
plan="$work/plan.txt"
if [ ! -s "$plan" ]; then
  start_tee "$work/units/plan" 400 || exit 1
  t11=$(date -u -d 2026-09-11 +%s); t10=$(date -u -d 2026-09-10 +%s)
  s12=$(first_at_or_after "$holdout") || exit 1
  s11=$(first_at_or_after "$t11") || exit 1
  s10=$(first_at_or_after "$t10") || exit 1
  stop_tee
  rm -rf "$work/units/plan/spool" # planning reads block times only: nothing spooled
  log "boundaries: first slot at/after 09-12 $s12, 09-11 $s11, 09-10 $s10"
  last=$(( s12 - 1 )) # nothing at or after 2026-09-12T00:00Z
  u11=$(( s11 / 4500 * 4500 )) u10=$(( s10 / 4500 * 4500 ))
  : > "$plan.tmp"
  for (( u = last / 4500 * 4500; u >= u11; u -= 4500 )); do
    to=$(( u + 4499 )); (( to > last )) && to=$last
    echo "2026-09-11 $(( u / 432000 )) $u $to" >> "$plan.tmp"
  done
  for (( u = u11 - 4500; u >= u10; u -= 4500 )); do
    echo "2026-09-10 $(( u / 432000 )) $u $(( u + 4499 ))" >> "$plan.tmp"
  done
  echo "$s12" > "$work/plan.s12"
  mv "$plan.tmp" "$plan"
  log "plan: $(wc -l < "$plan") units ($(grep -c 2026-09-11 "$plan") for 09-11, $(grep -c 2026-09-10 "$plan") for 09-10)"
fi

# --- Units -------------------------------------------------------------------------
decode_unit() { # DAY EP FROM TO UDIR: research tables, completeness, then delete the spool
  local day=$1 ep=$2 from=$3 to=$4 ud=$5
  local unit="$out/units/$ep/$from-$to" rdir="$res/units/$ep/$from-$to"
  "$bin/zeroed-tapedec" decode -spool "$ud/spool" -from-slot "$from" -to-slot "$to" -day "$day" \
    -out "$rdir" > "$ud/decode-stats.json" 2>> "$ud/decode.log" || { log "unit $from: decode failed"; return 1; }
  local cb db mv
  cb=$(jq -r '.blocks' "$unit/stats.json"); db=$(jq -r '.blocks + .dropped_blocks' "$ud/decode-stats.json"); mv=$(jq -r '.manifest_verified' "$ud/decode-stats.json")
  [[ "$cb" == "$db" && "$cb" == "$mv" ]] || { log "unit $from: decode incomplete (core $cb, decoded $db, verified $mv)"; rm -rf "$rdir"; return 1; }
  cp "$ud/spool/MANIFEST.tsv" "$ud/getblock-manifest.tsv"
  touch "$ud/decoded"
  rm -rf "$ud/spool"
  log "unit $from: decoded ($(jq -c '.rows' "$ud/decode-stats.json"))"
  [ "$keep" == 1 ] && return 0
  release_unit "$day" "$ep" "$from" "$to"
}
released() { # stored and read back
  if [ "$store" == hf ]; then grep -q "^$1	$2-$3	" "$work/stored-units.txt" 2>/dev/null; return; fi
  [ "$(awk -v u="$2-$3" '$2 == u {sub(/-.*/, "", $3); print $3}' "$work/released.tsv" 2>/dev/null | sort -u | wc -l)" -eq 3 ]
}
release_unit() { # DAY EP FROM TO: release assets, read back, then free the local copy
  local day=$1 ep=$2 from=$3 to=$4
  if [ "$store" == hf ]; then
    hfcmd=(python3 "$here/hfstore.py"); [ -z "${HFSTORE:-}" ] || hfcmd=("$HFSTORE")
    "${hfcmd[@]}" "$work" "$day" "$ep" "$from" "$to" >> "$work/release.log" 2>&1 || { log "unit $from: store failed (kept locally)"; return 1; }
  else
    bash "$here/release.sh" "$work" "$day" "$ep" "$from" "$to" >> "$work/release.log" 2>&1 || { log "unit $from: release failed (kept locally)"; return 1; }
  fi
  released "$day" "$from" "$to" || { log "unit $from: release not recorded"; return 1; }
  rm -rf "$out/units/$ep/$from-$to" "$res/units/$ep/$from-$to"
  log "unit $from: stored ($store) and read back; local copy removed"
}

s12=$(cat "$work/plan.s12") && [[ "$s12" =~ ^[0-9]+$ ]] || { log "plan.s12 missing: replan"; exit 1; }
phase0=446017500 # Phase 0's unit (PHASE0.md): already read; never read again
if [ -f "$out/units/1032/$phase0-$(( phase0 + 4499 ))/stats.json" ] && grep -q "Phase 0 done" "$work/phase0.log" 2>/dev/null; then
  mkdir -p "$work/units/$phase0"; touch "$work/units/$phase0/decoded"
fi
n=0 decpid= nread=0
while read -r day ep from to; do
  (( max > 0 && nread >= max )) && { log "MAX_UNITS $max reached: stopping (resumable)"; break; }
  [ -n "${ONLY_DAY:-}" ] && [ "$day" != "$ONLY_DAY" ] && continue
  n=$((n+1))
  unit="$out/units/$ep/$from-$to" rdir="$res/units/$ep/$from-$to" ud="$work/units/$from"
  released "$day" "$from" "$to" && continue
  if [ "$from" == "$phase0" ] && [ ! -f "$unit/stats.json" ]; then
    log "unit $from is Phase 0's (on zeroed-data branch tape): not read again"; continue
  fi
  if [ -f "$unit/stats.json" ] && [ -f "$rdir/stats.json" ] && [ -f "$ud/decoded" ]; then
    [ "$keep" == 1 ] && continue # kept local, done
    [ -z "$decpid" ] || { wait "$decpid" || exit 1; decpid=; }
    release_unit "$day" "$ep" "$from" "$to" || exit 1; continue
  fi
  if [ -f "$unit/stats.json" ]; then
    [ -f "$ud/verified" ] && [ -d "$ud/spool" ] || { log "unit $from: read but not verified (identity or replay unchecked): stopping for a decision"; exit 1; }
    [ -z "$decpid" ] || { wait "$decpid" || exit 1; decpid=; }; decode_unit "$day" "$ep" "$from" "$to" "$ud" || exit 1; continue
  fi
  left=$(( cap - $(used) ))
  (( left > 6000 )) || { log "Step A credit cap: $(used) of $cap used; stopping (resumable after a cap change)"; exit 3; }
  free=$(df -B1 --output=avail "$work" | tail -1)
  (( free > 12 * 1024**3 )) || { log "free disk $free below 12 GiB: stopping resumably (upload and clear a finished day)"; exit 75; }
  (( to < s12 )) || { log "unit $from-$to reaches 2026-09-12 (first slot $s12): refused"; exit 1; }
  if [ -f "$ud/ledger.json" ]; then log "unit $from: an earlier attempt's ledger exists (its credits were booked in advance)"; fi
  rm -rf "$ud"; start_tee "$ud" 6000 || exit 1
  nread=$((nread+1))
  t0=$(date +%s)
  timeout -s INT -k 120 2h env HELIUS_API_KEY=placeholder "$bin/zeroed-rpcscan" rpc-unit -out "$out" -epoch "$ep" \
    -from-slot "$from" -to-slot "$to" -sample 0.05 -helius-url "$tee_url" -rps 25 -conc "$conc" \
    -max-credits 6000 -usage-out "$ud/rpcscan-usage.json" 2>> "$ud/rpcscan.log"
  rc=$?
  stop_tee
  [ -f "$ud/STOP" ] && log "unit $from: tee stopped: $(cat "$ud/STOP")"
  key_check || { log "KEY FOUND IN A LOG: stopping"; exit 1; }
  if [ $rc -ne 0 ]; then log "unit $from: rpcscan exit $rc after $(( $(date +%s) - t0 ))s; stopping (resumable)"; exit "$rc"; fi
  "$bin/zeroed-tapedec" identity -usage "$ud/rpcscan-usage.json" -ledger "$ud/ledger.json" >> "$ud/identity.txt" 2>&1 ||
    { log "unit $from: identity failed: stopping"; exit 1; }
  log "unit $from ($day, $n/$(wc -l < "$plan")): read in $(( $(date +%s) - t0 ))s, $(jq -r .attempts "$ud/ledger.json") calls, 429s $(jq -r .http_429 "$ud/ledger.json"); credits $(used)"
  if (( every > 0 && n % every == 1 )); then
    "$bin/zeroed-rpcscan" rpc-unit -out "$ud/replay" -epoch "$ep" -from-slot "$from" -to-slot "$to" -sample 0.05 -dir "$ud/spool" 2>> "$ud/rpcscan.log" &&
      "$bin/zeroed-rpcscan" digest -unit "$unit" -o "$ud/live-digest.json.zst" &&
      "$bin/zeroed-rpcscan" digest-compare -baseline "$ud/live-digest.json.zst" -unit "$ud/replay/units/$ep/$from-$to" > "$ud/digest-compare.json" ||
      { log "unit $from: replay digest differs: stopping"; exit 1; }
    rm -rf "$ud/replay"; log "unit $from: replay digest equal"
  fi
  touch "$ud/verified"
  # Decode in the background while the next unit is read (one decode at a time).
  if [ -n "$decpid" ]; then wait "$decpid" || { log "a decode failed: stopping"; exit 1; }; fi
  decode_unit "$day" "$ep" "$from" "$to" "$ud" & decpid=$!
done < "$plan"
if [ -n "$decpid" ]; then wait "$decpid" || { log "the last decode failed"; exit 1; }; fi
key_check || { log "KEY FOUND IN A LOG"; exit 1; }
log "Step A read and decoded: $(wc -l < "$plan") units, credits $(used)"
