#!/bin/bash
# usage: wait_run.sh <run_id> ; exits when the workflow run completes, prints status and per-job conclusions
R=macdarenz-droid/Meme-snipe
for i in $(seq 1 360); do
  S=$(curl -s "https://api.github.com/repos/$R/actions/runs/$1" | python3 -c "import sys,json;d=json.load(sys.stdin);print(d.get('status'),d.get('conclusion'))" 2>/dev/null)
  case "$S" in completed*) echo "run $1: $S"; curl -s "https://api.github.com/repos/$R/actions/runs/$1/jobs" | python3 -c "
import sys,json
for j in json.load(sys.stdin)['jobs']:
  print(j['name'],j['conclusion']); [print('  ',s['name'],s['conclusion']) for s in j['steps']]"; exit 0;; esac
  sleep 20
done
echo timeout
