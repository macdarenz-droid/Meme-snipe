#!/bin/bash
# usage: wait_commit.sh <sha> ; exits when every check run on the commit has completed; prints results
R=macdarenz-droid/Meme-snipe
sleep 30
for i in $(seq 1 200); do
  OUT=$(curl -s "https://api.github.com/repos/$R/commits/$1/check-runs" | python3 -c "
import sys,json
d=json.load(sys.stdin); runs=d.get('check_runs',[])
if not runs: print('none'); sys.exit()
print(' '.join(f\"{r['name']}:{r['status']}:{r.get('conclusion')}\" for r in runs))" 2>/dev/null)
  if [ -n "$OUT" ] && [ "$OUT" != "none" ] && ! echo "$OUT" | grep -qE "queued|in_progress"; then echo "$1 -> $OUT"; exit 0; fi
  sleep 20
done
echo timeout
