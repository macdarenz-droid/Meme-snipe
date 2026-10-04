#!/usr/bin/env bash
# Reads one UTC chain day over Helius getBlock (DATA-2, BT-2e practice days; used by
# .github/workflows/data-scan.yml with source=helius). The day's units are written in
# the scanner's layout, so check-day.sh, package-day.sh and publish-day.sh run as for
# an archive day.
#   rpc-day.sh DAY OUT_DIR BUDGET RUN_CREDITS   (BUDGET: minutes, or seconds as "Ns")
# RUN_CREDITS is what this run may spend: the reservation the workflow booked in the
# account-wide ledger (ci/rpc-ledger.sh) before this step. The spend is written to
# OUT/rpc-usage-scan.json ("final" only at a clean exit) after OUT/rpc-started-scan
# marks the start, and the ledger settles it after the job: a run that dies keeps its
# whole reservation booked.
# Exit 0: the day is read. 75: the time budget or the rate-limit back-off budget ran
# out; progress is kept and the next chained run resumes. 3: no credits for this run
# (not resumable). Anything else fails.
# HELIUS_API_KEY comes from the environment and is never printed.
set -uo pipefail
day=$1 out=$2 budget=$3 credits=$4
next=$(date -u -d "$day + 1 day" +%F)
start=$(date +%s)
case $budget in
  *s) budget_s=${budget%s} ;;
  *) budget_s=$(( budget * 60 )) ;;
esac
[[ "$budget_s" =~ ^[0-9]+$ && "$credits" =~ ^[0-9]+$ ]] || { echo "bad budget '$budget' or credits '$credits'" >&2; exit 2; }
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
if [ "$credits" -le 0 ]; then
  echo "no credits reserved for this run of $day: stopping; not resumable" | tee -a "$summary"
  exit 3
fi
left=$(( start + budget_s - $(date +%s) ))
# Interrupted (SIGINT) at the budget's end; units are written atomically, so a unit cut
# off is reread by the next run.
rm -f "$out/rpc-usage-scan.json"
: > "$out/rpc-started-scan"
timeout -s INT -k 120 "$left" zeroed-rpcscan rpc-run -out "$out" -from "$day" -to "$next" -sample 0.05 \
  -rps "${RPC_RPS:-5}" -conc "${RPC_CONC:-4}" -max-credits "$credits" -usage-out "$out/rpc-usage-scan.json"
rc=$?
echo "credits spent reading $day in this run: $(tr -d '\n ' < "$out/rpc-usage-scan.json" 2>/dev/null || echo 'no usage file (the whole reservation stays booked)') of $credits reserved" | tee -a "$summary"
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
  3) echo "this run's $credits reserved credits are spent while reading $day: stopping; not resumable" | tee -a "$summary" ;;
  *) echo "RPC read failed with exit $rc" | tee -a "$summary" ;;
esac
exit "$rc"
