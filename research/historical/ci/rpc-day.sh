#!/usr/bin/env bash
# Reads one UTC chain day over Helius getBlock (DATA-2, BT-2e practice days; used by
# .github/workflows/data-scan.yml with source=helius). The day's units are written in
# the scanner's layout, so check-day.sh, package-day.sh and publish-day.sh run as for
# an archive day.
#   rpc-day.sh DAY OUT_DIR BUDGET MAX_CREDITS   (BUDGET: minutes, or seconds as "Ns")
# MAX_CREDITS is the cap for the whole day, across chained runs: the credits every run
# spent are summed in $OUT/rpc-credits-used (the determinism rescan in check-day.sh adds
# to it too), and each run may spend only what is left.
# Exit 0: the day is read. 75: the time budget or the rate-limit back-off budget ran
# out; progress is kept and the next chained run resumes. 3: the credit cap is spent;
# not resumable (raise the cap or wait for the plan's next month). Anything else fails.
# HELIUS_API_KEY comes from the environment and is never printed.
set -uo pipefail
here=$(cd "$(dirname "$0")" && pwd)
day=$1 out=$2 budget=$3 cap=$4
next=$(date -u -d "$day + 1 day" +%F)
start=$(date +%s)
case $budget in
  *s) budget_s=${budget%s} ;;
  *) budget_s=$(( budget * 60 )) ;;
esac
[[ "$budget_s" =~ ^[0-9]+$ && "$cap" =~ ^[0-9]+$ ]] || { echo "bad budget '$budget' or cap '$cap'" >&2; exit 2; }
summary=${GITHUB_STEP_SUMMARY:-/dev/null}
mkdir -p "$out"
# Units of another revision are reread, so a day never mixes revisions (as scan-day.sh).
if [ -n "${SCANNER_REVISION:-}" ]; then
  for st in "$out"/units/*/*/stats.json; do
    [ -f "$st" ] || continue
    rev=$(sed -n 's/.*"scanner_revision": *"\([^"]*\)".*/\1/p' "$st" | head -1)
    if [ "$rev" != "$SCANNER_REVISION" ]; then
      echo "unit $(dirname "$st") was read by revision '$rev', not '$SCANNER_REVISION': rereading it" | tee -a "$summary"
      rm -rf "$(dirname "$st")"
    fi
  done
fi
used=$("$here/rpc-credits.sh" get "$out")
left_credits=$(( cap - used ))
if [ "$left_credits" -le 0 ]; then
  echo "credit cap $cap spent ($used used for $day): stopping; not resumable" | tee -a "$summary"
  exit 3
fi
left=$(( start + budget_s - $(date +%s) ))
# Interrupted (SIGINT) at the budget's end; units are written atomically, so a unit cut
# off is reread by the next run.
rm -f "$out/rpc-usage-run.json"
timeout -s INT -k 120 "$left" zeroed-rpcscan rpc-run -out "$out" -from "$day" -to "$next" -sample 0.05 \
  -rps "${RPC_RPS:-5}" -conc "${RPC_CONC:-4}" -max-credits "$left_credits" -usage-out "$out/rpc-usage-run.json"
rc=$?
# Fail closed: credits spent but not booked would let the next run spend the full cap.
"$here/rpc-credits.sh" add "$out" "$out/rpc-usage-run.json" || { echo "credits for $day not booked (usage file unreadable): stopping; not resumable" | tee -a "$summary"; exit 1; }
used=$("$here/rpc-credits.sh" get "$out")
echo "credits for $day: $used of $cap used ($(cat "$out/rpc-usage-run.json" 2>/dev/null | tr -d '\n ' || echo 'no usage file'))" | tee -a "$summary"
if [ "$rc" -eq 0 ]; then
  echo "day $day read over RPC" | tee -a "$summary"
  exit 0
fi
if [ $(( start + budget_s - $(date +%s) )) -le 0 ] && [ "$rc" -ne 3 ]; then
  echo "time budget reached while reading (exit $rc); progress kept for the next run" | tee -a "$summary"
  exit 75
fi
case $rc in
  75) echo "rate-limit back-off budget used up; progress kept for the next run" | tee -a "$summary" ;;
  3) echo "credit cap $cap spent while reading $day: stopping; not resumable" | tee -a "$summary" ;;
  *) echo "RPC read failed with exit $rc" | tee -a "$summary" ;;
esac
exit "$rc"
