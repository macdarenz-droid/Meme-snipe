#!/bin/bash
# usage: peak.sh <cmd...> ; prints peak single-process RSS (MB) of node processes while cmd runs
"$@" > /tmp/claude-0/-home-user-Meme-snipe/6c4f17ef-f20d-5c18-865e-80aa086d701b/scratchpad/peak-out.txt 2>&1 &
pid=$!
peak=0
while kill -0 $pid 2>/dev/null; do
  m=$(ps -C node -o rss= | sort -n | tail -1)
  [ -n "$m" ] && [ "$m" -gt "$peak" ] && peak=$m
  sleep 0.2
done
wait $pid; rc=$?
echo "peak_mb=$((peak/1024)) rc=$rc $(grep -E 'Tests ' /tmp/claude-0/-home-user-Meme-snipe/6c4f17ef-f20d-5c18-865e-80aa086d701b/scratchpad/peak-out.txt)"
