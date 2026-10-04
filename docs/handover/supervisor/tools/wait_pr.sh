#!/bin/bash
# usage: wait_pr.sh <pr> ; exits when all check runs on the PR head are completed; prints head sha and conclusions
PR=$1; R=macdarenz-droid/Meme-snipe
for i in $(seq 1 120); do
  HEAD=$(curl -s https://api.github.com/repos/$R/pulls/$PR | python3 -c "import sys,json;print(json.load(sys.stdin)['head']['sha'])" 2>/dev/null)
  OUT=$(curl -s "https://api.github.com/repos/$R/commits/$HEAD/check-runs" | python3 -c "
import sys,json
d=json.load(sys.stdin); runs=d.get('check_runs',[])
if not runs: print('none'); sys.exit()
print(' '.join(f\"{r['name']}:{r['status']}:{r.get('conclusion')}\" for r in runs))" 2>/dev/null)
  if [ -n "$OUT" ] && [ "$OUT" != "none" ] && ! echo "$OUT" | grep -qE "queued|in_progress"; then echo "PR $PR head $HEAD -> $OUT"; exit 0; fi
  sleep 20
done
echo "PR $PR timeout; last: $HEAD $OUT"
