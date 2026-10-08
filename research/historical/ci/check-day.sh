#!/usr/bin/env bash
# Finalizes one scanned day on its own, runs the strict QA, the decoder parity check and
# the determinism check, and packages the day as release assets for `data-day-DAY`.
#   check-day.sh DAY OUT_DIR ASSET_DIR
# Archive source: MAX_MBPS (default ARCHIVE_MAX_MBPS) caps the determinism rescan, like the
# scan itself; above ARCHIVE_MAX_MBPS, or with the scanner's request cap above
# ARCHIVE_MAX_RPS (archive-limits.conf), or a day archive-guard.sh entry refuses (OF-2), it
# exits 2 before anything else; the rescan runs with the retention the day's units record.
set -euo pipefail
day=$1 out=$2 assets=$3
next=$(date -u -d "$day + 1 day" +%F)
here=$(cd "$(dirname "$0")" && pwd)
mkdir -p "$assets"
summary=${GITHUB_STEP_SUMMARY:-/dev/null}
if [ "${SOURCE:-archive}" != helius ]; then
  # shellcheck source=archive-limits.conf
  . "$here/archive-limits.conf"
  mb=${MAX_MBPS:-$ARCHIVE_MAX_MBPS}
  awk -v m="$mb" -v c="$ARCHIVE_MAX_MBPS" 'BEGIN { exit !(m + 0 > 0 && m + 0 <= c + 0) }' ||
    { echo "refused: max_mbps $mb is not in (0, $ARCHIVE_MAX_MBPS] (archive-limits.conf)" | tee -a "$summary"; exit 2; }
  "$here/scan-day.sh" --rps-ok "${ARCHIVE_GO:-$here/../scanner/archive.go}" > /dev/null ||
    { echo "refused: the scanner's request cap is not in (0, $ARCHIVE_MAX_RPS] (scanner/archive.go, archive-limits.conf)" | tee -a "$summary"; exit 2; }
  # ARCHIVE-NODUP: a Helius day is never read from the archive.
  [[ " $HELIUS_DAYS " == *" $day "* ]] &&
    { echo "refused: $day is a Helius day (HELIUS_DAYS in archive-limits.conf); it is never read from the archive" | tee -a "$summary"; exit 2; }
  # OF-2: allow-listed, armed, a retention value, and a fresh pass of the job's guard
  # step (store, storage-stop marker, 3-failure stop), before anything else.
  "$here/archive-guard.sh" entry "$day" > /dev/null || exit 2
  # The determinism rescan uses the day's recorded retention, never the current
  # ARCHIVE_RETENTION.
  rec=$("$here/archive-guard.sh" recorded "$out") || exit 2
  [ -n "$rec" ] || { echo "refused: the units of $day record no retention" | tee -a "$summary"; exit 2; }
  # A K3 day was read at K2 and trimmed (trim-day.sh): its rescan reads the unit at K2
  # and is compared with the K2 file hashes the per-unit log ($out/units.log) kept.
  if [ "$rec" = K3 ]; then
    [ -f "$out/units.log" ] || { echo "refused: the trimmed day $day has no per-unit log with its K2 hashes" | tee -a "$summary"; exit 2; }
  fi
fi
# phase NAME CMD...: runs CMD and logs pass or fail and its duration to the summary
# (sizes the 45 min QA-phase budget in data-scan.yml from real days). OF-2 round 4,
# ruling 23: the output of finalize and the QA tools (block and trade counts, accounts,
# slots) goes to $qlog in the day's progress (sealed when saved), never to the
# public job log or summary (archive-guard.sh ag_private_storage checks the redirects).
phase() {
  local name=$1 t0 rc=0
  shift
  t0=$(date +%s)
  "$@" || rc=$?
  if [ "$rc" -eq 0 ]; then echo "phase $name ($day): passed, $(( $(date +%s) - t0 )) s" | tee -a "$summary" >&2
  else echo "phase $name ($day): failed (exit $rc), $(( $(date +%s) - t0 )) s; its output is kept in the private log next to the data" | tee -a "$summary" >&2; fi
  return $rc
}
# Disk: the units (about 6.4-8.5 GB a day) and the one-day dataset can live on different
# volumes (DATASET_PARENT, e.g. /mnt on GitHub runners); free space is logged.
{ echo "### Disk before QA ($day)"; echo '```'; df -h "$out" "${DATASET_PARENT:-/tmp}" 2>/dev/null; echo '```'; } >> "$summary"
# Before finalize: room for the one-day dataset (at most about the units' size) + 5 GB.
units_bytes=$(du -sb "$out/units" | cut -f1)
"$here/disk-guard.sh" "${DATASET_PARENT:-/tmp}" $(( units_bytes + 5000000000 )) "the one-day QA dataset"
ds=$(mktemp -d -p "${DATASET_PARENT:-/tmp}")
# OF-3 ruling 24: inside the day's progress ($out/logs/qa), so a failed QA's output is
# saved with it, sealed (the "Save progress after QA" step), private and readable.
qlog="$out/logs/qa"; rm -rf "$qlog"; mkdir -p "$qlog"
# A single-day dataset without lead-in: universes are tokens created or graduated in
# that day's units. The multi-day dataset (assemble.sh) uses the 14-day lead-in.
phase finalize zeroed-scan finalize -out "$out" -dataset "$ds" -from "$day" -to "$next" -lead-in-days 0 -regimes "$here/../regimes.json" > "$qlog/finalize.log" 2>&1
phase qa node "$here/../qa/check.mjs" "$ds" --live 30 --strict --lead-in-days 0 > "$qlog/qa.log" 2>&1
phase parity node --no-warnings "$here/../qa/parity.ts" "$ds" > "$qlog/parity.log" 2>&1
# Regime volume per hour (DATA-1c): exact cross-check against the units' kept rows,
# then the plain CSV for release data-volume-DAY (ci/publish-volume.sh).
phase volume node --no-warnings "$here/../qa/volume.ts" "$ds" "$out/units" "$day" > "$qlog/volume.log" 2>&1
"$here/volume-asset.sh" "$ds" "$day" "$assets"
cp "$ds/qa/report.md" "$assets/qa-$day.md"
cp "$ds/qa/report.json" "$assets/qa-$day.json"
cp "$ds/qa/parity.json" "$assets/parity-$day.json"
cp "$ds/manifest.json" "$assets/manifest-$day.json"

# Determinism: rescan the day's first unit into a fresh directory; every data file
# must be byte-identical.
first=$(ls -d "$out"/units/*/* | grep -v '\.tmp$' | sort -V | head -1)
epoch=$(basename "$(dirname "$first")")
range=$(basename "$first")
again=$(mktemp -d)
mkdir -p "$again/cache" && cp "$out"/cache/* "$again/cache/" 2>/dev/null || true
# Archive: a 429 stops the rescan (scanner exit 75); the back-off in $out is held to at
# least ARCHIVE_BACKOFF_S and this exits 4, not resumable (ARCHIVE-SAFE): only a later
# served archive-check resumes. Helius: exit 75 is resumable. Any other failure is real
# (exit 1).
rc=0
if [ "${SOURCE:-archive}" = helius ]; then
  # A day read over RPC is reread over RPC; the credits count toward the day's cap
  # (RPC_CREDIT_CAP, the same total as rpc-day.sh). Exit 3: the cap is spent.
  used=$("$here/rpc-credits.sh" get "$out")
  [ $(( ${RPC_CREDIT_CAP:?} - used )) -gt 0 ] || { echo "credit cap spent before the determinism rescan" | tee -a "$summary"; exit 3; }
  phase determinism zeroed-rpcscan rpc-unit -out "$again" -epoch "$epoch" -from-slot "${range%-*}" -to-slot "${range#*-}" -sample 0.05 \
    -rps "${RPC_RPS:-5}" -conc "${RPC_CONC:-4}" -max-credits $(( RPC_CREDIT_CAP - used )) -usage-out "$again/rpc-usage.json" > "$qlog/determinism.log" 2>&1 || rc=$?
  "$here/rpc-credits.sh" add "$out" "$again/rpc-usage.json"
else
  phase determinism zeroed-scan unit -out "$again" -epoch "$epoch" -from-slot "${range%-*}" -to-slot "${range#*-}" -sample 0.05 -retention K2 -max-mbps "$mb" -dl "$ARCHIVE_DL" -on-429 stop -state "$out" > "$qlog/determinism.log" 2>&1 || rc=$?
fi
if [ "$rc" -eq 75 ] && [ "${SOURCE:-archive}" = helius ]; then
  echo "RPC rate-limit back-off ran out during the determinism rescan: stopping resumably; the next run redoes QA" | tee -a "$summary"
  exit 75
elif [ "$rc" -eq 75 ]; then
  "$here/scan-day.sh" --hold "$out/archive-429.state" "$ARCHIVE_BACKOFF_S"
  echo "archive answered 429 during the determinism rescan: back-off of at least $(( ARCHIVE_BACKOFF_S / 3600 )) h; the chain stops, and only a later served archive-check resumes this day" | tee -a "$summary"
  exit 4
elif [ "$rc" -eq 3 ] && [ "${SOURCE:-archive}" = helius ]; then
  echo "credit cap spent during the determinism rescan: stopping; not resumable" | tee -a "$summary"
  exit 3
elif [ "$rc" -ne 0 ]; then
  echo "determinism rescan failed (scanner exit $rc)" | tee -a "$summary"
  exit 1
fi
if [ "${rec:-}" = K3 ]; then
  # Trimmed day: the rescan (K2) must equal the K2 hashes logged before the trim.
  want=$(sed -n "s#^k2 \([0-9a-f]\{64\}\) $epoch/$range/\([^/]*\.zst\)\$#\1  $epoch/$range/\2#p" "$out/units.log" | LC_ALL=C sort)
  have=$(cd "$again/units" && sha256sum -- "$epoch/$range"/*.zst | LC_ALL=C sort)
  if [ -z "$want" ] || [ "$want" != "$have" ]; then echo "determinism check failed for $range: the K2 rescan differs from the logged K2 hashes"; exit 1; fi
else
  for f in "$first"/*.zst; do
    a=$(sha256sum "$f" | cut -d' ' -f1)
    b=$(sha256sum "$again/units/$epoch/$range/$(basename "$f")" | cut -d' ' -f1)
    if [ "$a" != "$b" ]; then echo "determinism check failed for $range/$(basename "$f")"; exit 1; fi
  done
fi
echo "determinism: unit $epoch/$range rescanned, every file identical" | tee -a "$summary"
if [ "${SOURCE:-archive}" != helius ]; then
  # OF-3: the release keeps the rescan unit's file hashes (equal to the day's unit, just
  # checked) and the per-unit log (revision, retention, migration list sha256 a unit).
  (cd "$again/units/$epoch/$range" && sha256sum -- *.zst | sed "s#  #  $epoch/$range/#") > "$assets/rescan-$day.sha256"
  if [ -f "$out/units.log" ]; then cp "$out/units.log" "$assets/units-$day.log"; else units=$(zeroed-scan unitlog -out "$out" 2>> "$qlog/unitlog.log"); printf '%s\n' "$units" > "$assets/units-$day.log"; fi
fi
rm -rf "$ds" "$qlog" "$again"
