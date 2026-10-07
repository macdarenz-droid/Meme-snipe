#!/bin/bash
# Resume the data pull after a container restart: drop a half-written last line from each jsonl, then start every step
# that is not running. Safe to run any time; each step skips what it already has.
cd "$(dirname "$0")"
for f in data/migrations.jsonl data/activity.jsonl data/migration_sigs.jsonl; do
  [ -f "$f" ] || continue
  python3 - "$f" <<'PY'
import json, sys
f = sys.argv[1]; L = open(f).read().split('\n')
good = []
for l in L:
    if not l: continue
    try: json.loads(l); good.append(l)
    except Exception: print('dropped bad line in', f)
open(f, 'w').write('\n'.join(good) + '\n')
PY
done
run() { pgrep -f "node $1" >/dev/null || { shift; nohup env "$@" > "logs/$(date +%s)_$RANDOM.log" 2>&1 & }; }
run "0[2]_migrations" ADAPT=0 WORKERS=4 RPC_GAP=330 node 02_migrations.mjs 1.0
run "0[3]_activity" ADAPT=0 RPC_GAP=400 node 03_activity.mjs --follow
run "0[4]_bars" node 04_bars.mjs --follow
sleep 1; pgrep -af "node 0" | grep -v bash
