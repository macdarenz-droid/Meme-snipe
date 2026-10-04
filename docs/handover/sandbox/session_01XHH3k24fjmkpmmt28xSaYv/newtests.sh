# ---- rpc-day.sh / check-day.sh (source helius): spend only the run's ledger reservation ----
R="$T/rpcbin"; mkdir -p "$R"
cat > "$R/zeroed-rpcscan" <<'STUB'
#!/usr/bin/env bash
# rpc-run / rpc-unit stand-in: logs its arguments, writes RPC_CREDITS into -usage-out
# ("final" when RPC_FINAL is set), sleeps RPC_SLEEP (interruptible: SIGINT writes the
# usage and exits 1), exits RPC_RC.
echo "$*" >> "$RPCLOG"
u=; while (( $# )); do [[ $1 == -usage-out ]] && u=$2; shift; done
w() { [[ -n "$u" && -z "${RPC_NOUSAGE:-}" ]] || return 0
  printf '{\n  "credits": %s,\n  "requests": 1,\n  "final": %s\n}\n' "${RPC_CREDITS:-0}" "${RPC_FINAL:-false}" > "$u"; }
trap 'w; exit 1' INT
[[ -n "${RPC_SLEEP:-}" ]] && { sleep "$RPC_SLEEP" & wait $!; }
w; exit "${RPC_RC:-0}"
STUB
chmod +x "$R/zeroed-rpcscan"
rd() { local o=$1; shift; : > "$T/summary.md"; env RPCLOG="$T/rpc.log" PATH="$R:$PATH" GITHUB_STEP_SUMMARY="$T/summary.md" "$@" \
  bash "$here/rpc-day.sh" 2026-09-21 "$o" "${RD_BUDGET:-5}" "${RD_CREDITS:-1000}" > "$T/out.txt" 2>&1; }
o="$T/rd1"; rm -rf "$o" "$T/rpc.log"
rc=0; rd "$o" RPC_CREDITS=100 RPC_FINAL=true RPC_RC=75 || rc=$?
[[ $rc == 75 && -e "$o/rpc-started-scan" ]] && grep -q -- "-max-credits 1000 -usage-out $o/rpc-usage-scan.json" "$T/rpc.log" && grep -q -- "-from 2026-09-21 -to 2026-09-22 " "$T/rpc.log" &&
  ok "rpc-day: spends at most the run's reservation, marks the start before spending, and a back-off stop exits 75 (resumable)" || no "rpc-day 75: rc=$rc $(cat "$T/out.txt")"
rc=0; rd "$o" RPC_CREDITS=1000 RPC_FINAL=true RPC_RC=3 || rc=$?
[[ $rc == 3 ]] && grep -q "reserved credits are spent while reading" "$T/summary.md" && ok "rpc-day: the reservation spent mid-run exits 3 (not resumable)" || no "rpc-day cap: rc=$rc"
n=$(wc -l < "$T/rpc.log"); rc=0; RD_CREDITS=0 rd "$o" || rc=$?
[[ $rc == 3 && $(wc -l < "$T/rpc.log") == "$n" ]] && ok "rpc-day: with nothing reserved, no request is made (exit 3)" || no "rpc-day spent: rc=$rc"
o="$T/rd2"; rm -rf "$o"; mkdir -p "$o/units/1046/1-2"; echo '{"scanner_revision": "old"}' > "$o/units/1046/1-2/stats.json"
rc=0; rd "$o" SCANNER_REVISION=new RPC_CREDITS=1 || rc=$?
[[ $rc == 0 && ! -e "$o/units/1046/1-2" ]] && ok "rpc-day: units of another revision are reread" || no "rpc-day revision"
o="$T/rd3"; rm -rf "$o"; t0=$(date +%s); rc=0; RD_BUDGET=2s rd "$o" RPC_SLEEP=30 RPC_CREDITS=7 RPC_FINAL=true || rc=$?
[[ $rc == 75 ]] && (( $(date +%s) - t0 < 20 )) && grep -q '"final":true' "$o/rpc-usage-scan.json" 2>/dev/null || grep -q '"final": true' "$o/rpc-usage-scan.json" &&
  ok "rpc-day: at the time budget the read is interrupted and exits 75 with its usage written" || no "rpc-day budget: rc=$rc $(cat "$T/out.txt")"
o="$T/rd5"; rm -rf "$o"; rc=0; rd "$o" RPC_CREDITS=100 RPC_FINAL=true RPC_RC=75 || rc=$?; rd "$o" RPC_NOUSAGE=1 RPC_RC=75 || true
[[ ! -e "$o/rpc-usage-scan.json" && -e "$o/rpc-started-scan" ]] && ok "rpc-day: an earlier run's usage file is removed before spending, so a run that writes none is never settled with it" || no "rpc-day stale usage"
# check-day, source helius: the determinism rescan goes over RPC within what is left of the reservation
cdh() {
  local o="$T/cdh-$1"; rm -rf "$o"; mkdir -p "$o/units/1046/1-2" "$T/cd-ds"; echo x > "$o/units/1046/1-2/blocks.csv.zst"
  [[ -n "${2:-}" ]] && printf '%s' "$2" > "$o/rpc-usage-scan.json"
  : > "$T/summary.md"; rm -f "$T/rpc.log"
  env SOURCE=helius RPC_RESERVATION=500 RPCLOG="$T/rpc.log" FAKE_AVAIL=999000000000 DATASET_PARENT="$T/cd-ds" PATH="$R:$C:$PATH" GITHUB_STEP_SUMMARY="$T/summary.md" "${@:3}" \
    bash "$here/check-day.sh" 2026-09-20 "$o" "$T/cdh-assets-$1" > "$T/out.txt" 2>&1
}
rc=0; cdh a '{"credits": 200, "final": true}' RPC_CREDITS=40 RESCAN_RC=1 || rc=$?
[[ -e "$T/cdh-a/rpc-started-rescan" ]] && grep -q -- "rpc-unit .*-epoch 1046 -from-slot 1 -to-slot 2 .*-max-credits 300 -usage-out $T/cdh-a/rpc-usage-rescan.json" "$T/rpc.log" &&
  ok "check-day (helius): the determinism rescan is an RPC rpc-unit within what is left of the reservation after the scan's final spend, start marked" || no "check-day helius rescan: rc=$rc $(cat "$T/rpc.log" 2>/dev/null) $(tail -3 "$T/out.txt")"
rc=0; cdh b '{"credits": 200, "final": false}' || rc=$?
[[ $rc == 3 && ! -s "$T/rpc.log" ]] && ok "check-day (helius): a scan spend that is not final counts as the whole reservation: no rescan request, exit 3" || no "check-day helius non-final: rc=$rc"
rc=0; cdh c '{"credits": 500, "final": true}' || rc=$?
[[ $rc == 3 && ! -s "$T/rpc.log" ]] && ok "check-day (helius): with the reservation spent, no rescan request and exit 3" || no "check-day helius cap: rc=$rc"
rc=0; cdh d '{"credits": 0, "final": true}' RPC_RC=75 || rc=$?
[[ $rc == 75 ]] && grep -q "RPC rate-limit back-off ran out during the determinism rescan" "$T/summary.md" && ok "check-day (helius): an RPC back-off stop in the rescan is resumable (75)" || no "check-day helius 75: rc=$rc"

# ---- rpc-ledger.sh: the account-wide credit ledger (DATA-4) ----
export GH_BIN="$T/bin/gh"
L="$T/ledger"; mkdir -p "$L"; rm -rf "$T/rel/helius-ledger"
led() { env LOCK_WAIT=0 LOCK_POLL=1 "$@"; }
lj() { python3 -c 'import json,sys; l=json.load(open(sys.argv[1])); print(eval(sys.argv[2]))' "$T/rel/helius-ledger/ledger.json" "$1"; }
rc=0; led bash "$here/rpc-ledger.sh" reserve r0 2026-09-20 500 500 "$L/res" 2>"$L/err" || rc=$?
[[ $rc == 1 && ! -e "$L/res" ]] && grep -q "refusing to spend credits" "$L/err" && ok "rpc-ledger: no ledger: reserve fails closed (exit 1, nothing reserved)" || no "rpc-ledger missing: rc=$rc $(cat "$L/err")"
mkdir -p "$T/rel/helius-ledger"; echo '{"period": "x"' > "$T/rel/helius-ledger/ledger.json"
rc=0; led bash "$here/rpc-ledger.sh" reserve r0 2026-09-20 500 500 "$L/res" 2>"$L/err" || rc=$?
[[ $rc == 1 && ! -e "$L/res" && ! -e "$T/rel/helius-ledger/ledger.lock" ]] && ok "rpc-ledger: an unreadable ledger fails closed, and the lock is released" || no "rpc-ledger unreadable: rc=$rc $(cat "$L/err")"
rm -rf "$T/rel/helius-ledger"
led bash "$here/rpc-ledger.sh" init 2026-10 1000 300 100 2026-09-21=100 >/dev/null && [[ $(lj 'l["used"], l["days"]') == "(100, {'2026-09-21': 100})" ]] &&
  ! led bash "$here/rpc-ledger.sh" init 2026-10 1000 0 2>/dev/null && [[ $(lj 'l["worker_budget"]') == 300 ]] &&
  ok "rpc-ledger: init creates the ledger with what was spent before it; a second init is refused" || no "rpc-ledger init"
rc=0; led bash "$here/rpc-ledger.sh" reserve r1 2026-09-20 500 800 "$L/r1" >/dev/null || rc=$?
rc2=0; led bash "$here/rpc-ledger.sh" reserve r2 2026-09-19 900 800 "$L/r2" >/dev/null || rc2=$?
rc3=0; led bash "$here/rpc-ledger.sh" reserve r3 2026-09-18 900 800 "$L/r3" 2>/dev/null || rc3=$?
[[ $rc == 0 && $(cat "$L/r1") == 500 && $rc2 == 0 && $(cat "$L/r2") == 100 && $rc3 == 3 && ! -e "$L/r3" ]] &&
  ok "rpc-ledger: reservations take the least of the run budget, the day cap and the month after the worker's share (500, then 100 of 1000 - 300 - 100), then exit 3" || no "rpc-ledger reserve: $rc $rc2 $rc3 $(cat "$L/r1" "$L/r2" 2>/dev/null)"
rc=0; led bash "$here/rpc-ledger.sh" reserve r1 2026-09-20 500 1 "$L/rx" 2>/dev/null || rc=$?
[[ $rc == 1 ]] && ok "rpc-ledger: an id already holding a reservation is refused" || no "rpc-ledger duplicate id: rc=$rc"
w="$L/w1"; mkdir -p "$w"; : > "$w/rpc-started-scan"; echo '{"credits": 120, "final": true}' > "$w/rpc-usage-scan.json"
: > "$w/rpc-started-rescan"; echo '{"credits": 30, "final": true}' > "$w/rpc-usage-rescan.json"
led bash "$here/rpc-ledger.sh" settle r1 "$w" >/dev/null && [[ $(lj 'l["used"], l["days"]["2026-09-20"], [o["id"] for o in l["outstanding"]]') == "(250, 150, ['r2'])" ]] &&
  ok "rpc-ledger: settle books the final spend of the scan and the rescan and closes the reservation" || no "rpc-ledger settle: $(lj 'l')"
w="$L/w2"; mkdir -p "$w"; : > "$w/rpc-started-scan"; echo '{"credits": 7, "final": false}' > "$w/rpc-usage-scan.json"
led bash "$here/rpc-ledger.sh" settle r2 "$w" >/dev/null && [[ $(lj 'l["used"], l["days"]["2026-09-19"], l["outstanding"]') == "(350, 100, [])" ]] &&
  ok "rpc-ledger: a spend without a final usage file (a killed run) books the whole reservation, never the last count written" || no "rpc-ledger kill: $(lj 'l')"
led bash "$here/rpc-ledger.sh" reserve r4 2026-09-18 900 50 "$L/r4" >/dev/null; w="$L/w4"; mkdir -p "$w"; : > "$w/rpc-started-scan"
led bash "$here/rpc-ledger.sh" settle r4 "$w" >/dev/null && [[ $(lj 'l["used"]') == 400 ]] && ok "rpc-ledger: a spend that started with no usage file books the whole reservation" || no "rpc-ledger no usage: $(lj 'l')"
led bash "$here/rpc-ledger.sh" reserve r5 2026-09-18 900 50 "$L/r5" >/dev/null; w="$L/w5"; mkdir -p "$w"
led bash "$here/rpc-ledger.sh" settle r5 "$w" >/dev/null && [[ $(lj 'l["used"]') == 400 ]] && ok "rpc-ledger: a run that never started spending books nothing" || no "rpc-ledger no start: $(lj 'l')"
# A run killed before settle leaves its reservation outstanding: the next reservation sees it.
led bash "$here/rpc-ledger.sh" reserve r6 2026-09-17 900 150 "$L/r6" >/dev/null
rc=0; led bash "$here/rpc-ledger.sh" reserve r7 2026-09-16 900 150 "$L/r7" >/dev/null || rc=$?
[[ $(cat "$L/r6") == 150 && $(cat "$L/r7") == 50 ]] && ok "rpc-ledger: an unsettled reservation (a lost runner) stays booked against the month" || no "rpc-ledger outstanding: $(cat "$L/r6" "$L/r7")"
before=$(cat "$T/rel/helius-ledger/ledger.json"); echo held > "$T/rel/helius-ledger/ledger.lock"
rc=0; led bash "$here/rpc-ledger.sh" settle r6 "$L/w5" 2>"$L/err" || rc=$?
[[ $rc == 1 && "$(cat "$T/rel/helius-ledger/ledger.json")" == "$before" && -e "$T/rel/helius-ledger/ledger.lock" ]] && grep -q "stayed locked" "$L/err" &&
  ok "rpc-ledger: while another job holds the lock, a writer fails closed and changes nothing" || no "rpc-ledger lock: rc=$rc $(cat "$L/err")"
bash "$here/rpc-ledger.sh" unlock >/dev/null && [[ ! -e "$T/rel/helius-ledger/ledger.lock" ]] && led bash "$here/rpc-ledger.sh" settle r6 "$L/w5" >/dev/null &&
  [[ ! -e "$T/rel/helius-ledger/ledger.lock" ]] && ok "rpc-ledger: unlock clears a stale lock; a writer releases its own lock" || no "rpc-ledger unlock"
# End to end: a day read killed mid-unit is settled at its whole reservation (the old
# per-run total booked only the last count the scanner wrote).
o="$T/rdk"; rm -rf "$o"; rc=0; RD_CREDITS=$(cat "$L/r7") rd "$o" RPC_CREDITS=7 RPC_RC=137 || rc=$?
led bash "$here/rpc-ledger.sh" settle r7 "$o" >/dev/null && [[ $rc == 137 && $(lj '[s["actual"] for s in l["settled"] if s["id"] == "r7"]') == "[50]" ]] &&
  ok "rpc-day + rpc-ledger: a read killed mid-unit (usage not final) is settled at its whole reservation" || no "rpc-day kill settle: rc=$rc $(lj 'l["settled"]')"
unset GH_BIN

