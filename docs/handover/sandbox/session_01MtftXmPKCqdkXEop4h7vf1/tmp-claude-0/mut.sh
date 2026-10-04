#!/bin/bash
# usage: mut.sh file 'python-replace-old' 'new' tests...
f=$1; old=$2; new=$3; shift 3
cp "$f" /tmp/claude-0/mut.bak
python3 - "$f" "$old" "$new" <<'P'
import sys
p,o,n=sys.argv[1:4]
s=open(p).read()
assert s.count(o)==1, ('count', s.count(o), o)
open(p,'w').write(s.replace(o,n))
P
timeout 900 pnpm exec vitest run "$@" 2>&1 | grep -E "Tests " | tail -1
cp /tmp/claude-0/mut.bak "$f"
