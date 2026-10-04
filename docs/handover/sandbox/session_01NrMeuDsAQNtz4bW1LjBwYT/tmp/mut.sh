#!/bin/bash
cd /home/user/rv-mut
run() { name="$1"; file="$2"; from="$3"; to="$4"
  cp "$file" /tmp/claude-0/bak
  python3 - "$file" "$from" "$to" <<'P'
import sys; f,a,b=sys.argv[1:]; s=open(f).read()
assert s.count(a)==1, ("count",s.count(a),a); open(f,'w').write(s.replace(a,b))
P
  [ $? -ne 0 ] && { echo "$name: PATCH-FAIL"; cp /tmp/claude-0/bak "$file"; return; }
  out=$(timeout 300 npx vitest run packages/worker/test/marks.test.ts packages/worker/test/position-market.test.ts 2>&1 | grep -E "Tests ")
  echo "$name: $out"; cp /tmp/claude-0/bak "$file"; }
M=packages/worker/src/engine/marks.ts; V=packages/core/src/exits/value.ts; S=packages/worker/src/engine/strategy.ts
run stale $M 'nowMs - m.atMs > s.maxAgeMs || ' ''
run stale-off-by-one $M 'nowMs - m.atMs > s.maxAgeMs' 'nowMs - m.atMs >= s.maxAgeMs'
run future $M ' || m.atMs > nowMs' ''
run sol-null $M 'sol === null || sol.value <= 0n || ' 'sol === null || '
run sol-null-check $M 'sol === null || ' 'false || '
run mark-date $M 'markAtMs: m.atMs }' 'markAtMs: nowMs }'
run sol-round $M "sol.value, 'floor')" "sol.value, 'ceil')"
run slippage $V '(BPS_DENOMINATOR - BigInt(o.slippageBps))' 'BPS_DENOMINATOR'
run cost $V 'minOut > o.exitCost ? minOut - o.exitCost : 0n' 'minOut'
run floor $V 'minOut > o.exitCost ? minOut - o.exitCost : 0n' 'minOut - o.exitCost'
run exit-unmarked $S 'account: this.#marked(risk.history, ctx, sol), latches: risk.latches' 'account: risk.history, latches: risk.latches'
run exitcost-fee $S '+ step.priorityFeeLamports + n.tip' '+ n.tip'
run exitcost-tip $S '+ step.priorityFeeLamports + n.tip' '+ step.priorityFeeLamports'
run flagged-ignore packages/worker/src/engine/strategy.ts 'if (flags.length > 0) return' 'if (false) return'
run trip-log $S 'if (r.tripped.length > 0) why.push' 'if (false) why.push'
