#!/bin/sh
# REPLAY-1000: keeps the day's data current while the day and its windows run out (every 20 minutes until <untilIso>):
# the migration list, the slot index, Coinbase's SOL-USD history, and the full tapes of newly finished sample coins.
#   sh research/replay-1000/follow.sh <day> <untilIso>
day="$1"; until_s=$(date -d "$2" +%s)
while [ "$(date +%s)" -lt "$until_s" ]; do
  node research/replay-1000/coins.ts migrations "$day"
  node research/replay-1000/coins.ts index 2026-10-03T23:00:00Z
  node research/replay-1000/coinbase.ts trades 2026-10-04T22:00:00Z "$(date -u -d '+1 hour' +%Y-%m-%dT%H:%M:%SZ)"
  node research/replay-1000/coinbase.ts candles 2026-09-20T00:00:00Z "$(date -u -d '+1 hour' +%Y-%m-%dT%H:%M:%SZ)"
  REPLAY_SPACING_MS=6 COINS_IN_FLIGHT=4 node research/replay-1000/collect.ts "$day" 24 sample
  sleep 1200
done
