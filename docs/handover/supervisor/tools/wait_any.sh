#!/bin/bash
# usage: wait_any.sh <pr>... ; exits when CI on any listed PR head has fully completed; prints that PR and results
R=macdarenz-droid/Meme-snipe
sleep 30
for i in $(seq 1 320); do
  for PR in "$@"; do
    HEAD=$(curl -s https://api.github.com/repos/$R/pulls/$PR | python3 -c "import sys,json;print(json.load(sys.stdin)['head']['sha'])" 2>/dev/null)
    OUT=$(curl -s "https://api.github.com/repos/$R/commits/$HEAD/check-runs" | python3 -c "
import sys,json
d=json.load(sys.stdin); runs=d.get('check_runs',[])
if not runs: print('none'); sys.exit()
print(' '.join(f\"{r['name']}:{r['status']}:{r.get('conclusion')}\" for r in runs))" 2>/dev/null)
    if [ -n "$OUT" ] && [ "$OUT" != "none" ] && ! echo "$OUT" | grep -qE "queued|in_progress" && echo "$OUT" | grep -qE "check:completed:(success|failure|cancelled|timed_out)"; then echo "PR $PR head $HEAD -> $OUT"; exit 0; fi
  done
  sleep 20
done
echo "timeout"
