#!/usr/bin/env bash
# Exits when any Actions run created after $1 (UTC ISO) has concluded with success (so jobs start again); checks every 3 min, up to 6 h.
since="$1"
for i in $(seq 1 120); do
  out=$(curl -s "https://api.github.com/repos/macdarenz-droid/Meme-snipe/actions/runs?per_page=30" | python3 -c "
import json,sys
d=json.load(sys.stdin)
for r in d.get('workflow_runs',[]):
    if r['created_at']>sys.argv[1] and r['conclusion']=='success':
        print(r['id'], r['name'], r['status'], r['conclusion'], r['head_branch']); break
" "$since")
  if [ -n "$out" ]; then echo "UNLOCKED? $out"; exit 0; fi
  sleep 180
done
echo "still locked after 6h"
