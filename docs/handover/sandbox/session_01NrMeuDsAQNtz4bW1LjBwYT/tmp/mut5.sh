#!/bin/bash
cd /home/user/rv-mut
run() { name="$1"; file="$2"; from="$3"; to="$4"
  cp "$file" /tmp/claude-0/bak
  python3 - "$file" "$from" "$to" <<'P'
import sys; f,a,b=sys.argv[1:]; s=open(f).read()
assert s.count(a)==1, ("count",s.count(a),a); open(f,'w').write(s.replace(a,b))
P
  [ $? -ne 0 ] && { echo "$name: PATCH-FAIL"; cp /tmp/claude-0/bak "$file"; return; }
  out=$(timeout 1200 npx vitest run packages/worker/test 2>&1 | grep -E "Tests ")
  echo "$name: $out"; cp /tmp/claude-0/bak "$file"; }
M=packages/worker/src/engine/marks.ts; V=packages/core/src/exits/value.ts; S=packages/worker/src/engine/strategy.ts
S=packages/worker/src/engine/strategy.ts
run entry-unmarked $S 'account: this.#marked(acct.history, ctx, sol), latches: acct.latches' 'account: acct.history, latches: acct.latches'
run slip-source $S 'slippageBps: step.minOutBelowTriggerBps,' 'slippageBps: 0,'
run exitcost-zero $S 'exitCost: n.signaturesPerTx * n.baseFeePerSignature + step.priorityFeeLamports + n.tip,' 'exitCost: 0n,'
run maxage-source $S 'maxAgeMs: policy.gates.maxQuoteAgeMs,' 'maxAgeMs: 1e12,'
