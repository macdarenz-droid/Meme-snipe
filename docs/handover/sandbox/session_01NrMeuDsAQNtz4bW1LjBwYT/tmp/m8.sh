cd /home/user/rv5
run() { name="$1"; file="$2"; from="$3"; to="$4"
  cp "$file" /tmp/claude-0/bak
  python3 - "$file" "$from" "$to" <<'P' || { echo "$name: PATCH-FAIL"; return; }
import sys; f,a,b=sys.argv[1:]; s=open(f).read()
assert s.count(a)==1, ("count",s.count(a)); open(f,'w').write(s.replace(a,b))
P
  out=$(timeout 300 npx vitest run packages/worker/test/marks.test.ts packages/worker/test/position-market.test.ts 2>&1 | grep -E "Tests |  × ")
  echo "$name: $out"; cp /tmp/claude-0/bak "$file"; }
M=packages/worker/src/engine/marks.ts
run maxage $M 'maxAgeMs: policy.gates.maxQuoteAgeMs }' 'maxAgeMs: 1e12 }'
run sol-fresh $M '!fresh(sol.atMs, nowMs, s.maxAgeMs) || ' ''
run market-fresh $M ' || !fresh(m.atMs, nowMs, s.maxAgeMs)' ''
